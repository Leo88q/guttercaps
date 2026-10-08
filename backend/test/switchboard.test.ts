import { describe, expect, it, vi } from 'vitest';
import { PublicKey, type Connection } from '@solana/web3.js';
import { createSwitchboardService, liveOracle } from '../src/switchboard.ts';
import { gatewayBaseUrl, publicAddress, revealPayload, SwitchboardError } from '../src/switchboard-gateway.ts';
import { SWITCHBOARD_QUEUE, SWITCHBOARD_PROGRAM_ID } from '../src/config.ts';
import { rngAuthPda, RNG_KIND } from '../src/chain.ts';
import { FakeConnection, encodeRandomness, encodeOracle, pk } from './chainFixtures.ts';

const queue = new PublicKey(SWITCHBOARD_QUEUE), oracle = pk(), randomness = pk();
const payload = { signature: Buffer.alloc(64, 7).toString('base64'), recovery_id: 1, value: Array(32).fill(19) };
const health = (key = oracle.toBase58()) => ({ oracles: [{ oracle_config: { pull_oracle: key, enable_pull_oracle: 1, restricted: false } }] });
function world() {
  const conn = new FakeConnection();
  const fields = { authority: rngAuthPda(RNG_KIND.BATTLE)[0], queue, oracle, seedSlot: 4000n };
  conn.set(randomness, encodeRandomness(fields), SWITCHBOARD_PROGRAM_ID);
  const data = encodeOracle('https://oracle.example.com'); data.set(queue.toBytes(), 3472);
  conn.set(oracle, data, SWITCHBOARD_PROGRAM_ID);
  const gateway = vi.fn(async (_origin: string, op: string, _body?: unknown) => op === 'healthy_oracles' ? health() : payload);
  const load = vi.fn(async () => ({ genesis: 'devnet-genesis', candidates: [{ oracle: oracle.toBase58(), gateway: 'https://oracle.example.com', eligible: true }] }));
  const service = createSwitchboardService(() => conn as unknown as Connection, { gateway, load });
  return { conn, service, gateway, load, fields };
}

describe('Switchboard service (no wallet or transaction)', () => {
  it('single-flights concurrent readiness probes and caches only briefly', async () => {
    const w = world();
    const [a, b] = await Promise.all([w.service.health(), w.service.health()]);
    expect(a).toEqual(b); expect(a).toMatchObject({ ready: true, oracle: oracle.toBase58() });
    await w.service.health();
    expect(w.load).toHaveBeenCalledTimes(1); expect(w.gateway).toHaveBeenCalledTimes(1);
    expect(w.conn.sent).toHaveLength(0);
  });
  it('preserves the same prefixed base for health and committed reveal, without exposing the path in health JSON', async () => {
    const w = world();
    // Synthetic prefix on the host reported by the user; not a guess of the live path.
    const base = 'https://141.95.35.110.xip.switchboard-oracles.xyz/rpc/';
    w.load.mockResolvedValue({ genesis: 'devnet', candidates: [{ oracle: oracle.toBase58(), gateway: base, eligible: true }] });
    const data = encodeOracle(base); data.set(queue.toBytes(), 3472);
    w.conn.set(oracle, data, SWITCHBOARD_PROGRAM_ID);
    const report = await w.service.health();
    expect(report).toMatchObject({ ready: true, probes: [{ gateway: 'https://141.95.35.110.xip.switchboard-oracles.xyz', healthy: true }] });
    expect(w.gateway).toHaveBeenNthCalledWith(1, base.slice(0, -1), 'healthy_oracles');
    await w.service.reveal(randomness.toBase58());
    expect(w.gateway).toHaveBeenNthCalledWith(2, base.slice(0, -1), 'randomness_reveal', expect.objectContaining({
      slot: 4000, randomness_key: randomness.toBuffer().toString('hex'), slothash: Array(32).fill(0xab),
    }));
    expect(w.conn.sent).toHaveLength(0);
  });
  it('skips an unhealthy gateway and selects another live, on-chain eligible oracle', async () => {
    const w = world(), other = pk().toBase58();
    w.load.mockResolvedValue({ genesis: 'devnet', candidates: [
      { oracle: oracle.toBase58(), gateway: 'https://dead.example.com', eligible: true },
      { oracle: other, gateway: 'https://oracle.example.com', eligible: true },
      { oracle: pk().toBase58(), gateway: 'https://stale.example.com', eligible: false },
    ] });
    w.gateway.mockImplementation(async origin => {
      if (origin.includes('dead')) throw new SwitchboardError('gateway_http_502');
      return health(other);
    });
    const h = await w.service.health();
    expect(h).toMatchObject({ ready: true, oracle: other, eligibleMembers: 2 });
    expect(h.probes[0].code).toBe('gateway_http_502');
    expect(w.gateway).toHaveBeenCalledTimes(2);
  });
  it('fails closed when live health is missing (no on-chain-only fallback)', async () => {
    const w = world(); w.gateway.mockRejectedValue(new SwitchboardError('gateway_dns'));
    expect(await w.service.health()).toMatchObject({ ready: false, oracle: null, probes: [{ code: 'gateway_dns' }] });
    expect(w.conn.sent).toHaveLength(0);
  });
  it('never selects a live oracle with stale/invalid on-chain credentials', async () => {
    const w = world(); w.load.mockResolvedValue({ genesis: 'x', candidates: [{ oracle: oracle.toBase58(), gateway: 'https://oracle.example.com', eligible: false }] });
    expect((await w.service.health()).ready).toBe(false); expect(w.gateway).not.toHaveBeenCalled();
  });
  it('relays exactly the committed oracle/seed with only a public RPC URL', async () => {
    const w = world(); const result = await w.service.reveal(randomness.toBase58());
    expect(result).toEqual({ ...payload, randomness: randomness.toBase58(), oracle: oracle.toBase58(), queue: queue.toBase58() });
    expect(w.gateway).toHaveBeenCalledWith('https://oracle.example.com', 'randomness_reveal', {
      slot: 4000, randomness_key: randomness.toBuffer().toString('hex'), slothash: Array(32).fill(0xab), rpc: 'https://api.devnet.solana.com',
    });
    expect(w.conn.sent).toHaveLength(0); expect(w.load).not.toHaveBeenCalled();
  });
  it.each(['owner', 'authority', 'queue', 'oracle-owner', 'oracle-queue', 'uncommitted', 'revealed'] as const)('rejects %s mismatch BEFORE gateway HTTP', async problem => {
    const w = world();
    if (problem === 'owner') w.conn.set(randomness, encodeRandomness(w.fields), pk());
    if (problem === 'authority') w.conn.set(randomness, encodeRandomness({ ...w.fields, authority: pk() }), SWITCHBOARD_PROGRAM_ID);
    if (problem === 'queue') w.conn.set(randomness, encodeRandomness({ ...w.fields, queue: pk() }), SWITCHBOARD_PROGRAM_ID);
    if (problem === 'uncommitted') w.conn.set(randomness, encodeRandomness({ ...w.fields, seedSlot: 0n, lutSlot: 0n }), SWITCHBOARD_PROGRAM_ID);
    if (problem === 'revealed') w.conn.set(randomness, encodeRandomness({ ...w.fields, revealSlot: 4001n }), SWITCHBOARD_PROGRAM_ID);
    if (problem === 'oracle-owner') w.conn.set(oracle, encodeOracle('https://oracle.example.com'), pk());
    if (problem === 'oracle-queue') w.conn.set(oracle, encodeOracle('https://oracle.example.com'), SWITCHBOARD_PROGRAM_ID);
    await expect(w.service.reveal(randomness.toBase58())).rejects.toBeInstanceOf(SwitchboardError);
    expect(w.gateway).not.toHaveBeenCalled();
  });
  it('does not expose RPC error text or endpoint credentials', async () => {
    const w = world(); w.load.mockRejectedValue(new Error('https://secret.invalid?api-key=PRIVATE'));
    await expect(w.service.health()).rejects.toMatchObject({ code: 'switchboard_rpc_unavailable', message: 'switchboard_rpc_unavailable' });
  });
});

describe('gateway boundary', () => {
  it.each(['http://oracle.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://user:secret@example.com', 'https://oracle.example.com?key=SECRET', 'https://localhost', 'https://oracle.example.com:8080'])('rejects unsafe URI %s', uri => {
    expect(() => gatewayBaseUrl(uri)).toThrow('unsafe_gateway');
  });
  it.each(['/rpc', '/rpc/', '/nested/route', '/nested/route///'])('preserves the verified gateway base path %s', path => {
    expect(gatewayBaseUrl(`https://oracle.example.com${path}`)).toBe(`https://oracle.example.com${path.replace(/\/+$/, '')}`);
  });
  it.each(['https://oracle.example.com/prefix?key=SECRET', 'https://oracle.example.com/prefix#fragment',
    'https://user:secret@oracle.example.com/prefix', 'https://oracle.example.com/a\\b',
    'https://oracle.example.com/a\nb', 'https://oracle.example.com/a\0b'])('rejects ambiguous or credential-bearing base %s', uri => {
    expect(() => gatewayBaseUrl(uri)).toThrow('unsafe_gateway');
  });
  it.each(['127.0.0.1', '10.2.3.4', '172.31.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::', '2001:db8::1'])('rejects non-public DNS answer %s', ip => expect(publicAddress(ip)).toBe(false));
  it('accepts public IPv4 / global IPv6 and canonical HTTPS origins', () => {
    expect(publicAddress('8.8.8.8')).toBe(true); expect(publicAddress('2606:4700:4700::1111')).toBe(true);
    expect(gatewayBaseUrl('https://oracle.example.com/')).toBe('https://oracle.example.com');
  });
  it('requires the selected oracle, unrestricted pull-oracle service and strict bytes', () => {
    expect(liveOracle(health(), pk().toBase58())).toBe(false);
    const h = health(); h.oracles[0].oracle_config.restricted = true; expect(liveOracle(h, oracle.toBase58())).toBe(false);
    expect(revealPayload(payload)).toEqual(payload);
    for (const bad of [{ ...payload, recovery_id: 256 }, { ...payload, value: Array(32).fill(-1) }, { ...payload, value: Array(32).fill(1.5) }, { ...payload, signature: 'x'.repeat(88) }]) expect(() => revealPayload(bad)).toThrow('gateway_schema');
  });
});
