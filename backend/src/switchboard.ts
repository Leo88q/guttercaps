import { Connection, PublicKey } from '@solana/web3.js';
import { SWITCHBOARD_PROGRAM_ID as PROGRAM, SWITCHBOARD_QUEUE } from './config.ts';
import { decodeRandomness, decodeOracleGateway, rngAuthPda, RNG_KIND } from './chain.ts';
import { gatewayBaseUrl, readGateway, readGatewayRegistry, parseGatewayRegistry, revealPayload, SwitchboardError, type GatewayRead } from './switchboard-gateway.ts';

const QUEUE = new PublicKey(SWITCHBOARD_QUEUE);
const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export interface Candidate { oracle: string; gateway: string; eligible: boolean; eligibleUntilMs?: number }
export interface QueueSnapshot { genesis: string; candidates: Candidate[] }
type Sb = typeof import('@switchboard-xyz/on-demand');
type Program = Awaited<ReturnType<Sb['AnchorUtils']['loadProgramFromConnection']>>;
const programs = new WeakMap<Connection, Promise<Program>>();
const connections = new WeakMap<Connection, Connection>();
/** Dedicated HTTP-only, bounded RPC reads; never a WebSocket or transaction sender. */
export function switchboardConnection(source: Connection): Connection {
  let conn = connections.get(source);
  if (!conn) {
    conn = new Connection(source.rpcEndpoint, { commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }) });
    connections.set(source, conn);
  }
  return conn;
}

/** Decode only owned accounts from the pinned queue. No Crossbar discovery or SDK HTTP health calls. */
export async function loadQueue(connection: Connection): Promise<QueueSnapshot> {
  const genesis = await connection.getGenesisHash();
  const expected = PROGRAM.toBase58() === 'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2' ? DEVNET :
    PROGRAM.toBase58() === 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv' ? MAINNET : '';
  if (!expected || genesis !== expected) throw new SwitchboardError('switchboard_cluster_mismatch');
  let pending = programs.get(connection);
  if (!pending) {
    pending = (async () => {
      const sb = await import('@switchboard-xyz/on-demand');
      // SDK's default wallet is read-only and throws on every signing method.
      return sb.AnchorUtils.loadProgramFromConnection(connection, undefined, PROGRAM);
    })();
    programs.set(connection, pending);
    void pending.catch(() => programs.delete(connection));
  }
  const program = await pending;
  const info = await connection.getAccountInfo(QUEUE, 'confirmed');
  if (!info?.owner.equals(PROGRAM)) throw new SwitchboardError('switchboard_queue_owner');
  // Anchor normalizes these names to camelCase (the same names used by SDK Queue/Oracle.loadData).
  const queue = program.coder.accounts.decode('queueAccountData', info.data) as Awaited<ReturnType<Sb['Queue']['loadData']>>;
  if (!Number.isInteger(queue.oracleKeysLen) || queue.oracleKeysLen < 0 || queue.oracleKeysLen > 128 || queue.oracleKeysLen > queue.oracleKeys.length) {
    throw new SwitchboardError('switchboard_queue_schema');
  }
  const keys = queue.oracleKeys.slice(0, queue.oracleKeysLen);
  const candidates: Candidate[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < keys.length; i += 100) {
    const accounts = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), 'confirmed');
    accounts.forEach((account, n) => {
      if (!account?.owner.equals(PROGRAM)) return;
      try {
        const data = program.coder.accounts.decode('oracleAccountData', account.data) as Awaited<ReturnType<Sb['Oracle']['loadData']>>;
        const age = now - data.lastHeartbeat.toNumber();
        candidates.push({ oracle: keys[i + n].toBase58(), gateway: decodeOracleGateway(account.data),
          eligibleUntilMs: Math.min(data.enclave.validUntil.toNumber(), data.lastHeartbeat.toNumber() + queue.nodeTimeout.toNumber() + 1) * 1000,
          eligible: data.queue.equals(QUEUE) && data.isOnQueue && data.enclave.verificationStatus === 4 &&
            age >= -30 && age <= queue.nodeTimeout.toNumber() && data.enclave.validUntil.toNumber() > now });
      } catch { /* malformed accounts are not eligible */ }
    });
  }
  return { genesis, candidates };
}

export function liveOracle(raw: unknown, oracle: string): boolean {
  const j = raw as { oracles?: { oracle_config?: { pull_oracle?: unknown; restricted?: unknown; enable_pull_oracle?: unknown } }[] } | null;
  return !!j && Array.isArray(j.oracles) && j.oracles.some(o => {
    const c = o?.oracle_config;
    return c?.pull_oracle === oracle && !c.restricted && c.enable_pull_oracle === 1;
  });
}
export function createSwitchboardService(connection: () => Connection, deps: {
  load?: typeof loadQueue; gateway?: GatewayRead; registry?: typeof readGatewayRegistry; now?: () => number;
} = {}) {
  const load = deps.load ?? loadQueue, gateway = deps.gateway ?? readGateway, now = deps.now ?? Date.now;
  const registry = deps.registry ?? readGatewayRegistry;
  let active = 0, cacheDeadline = Infinity;
  async function limited<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= 8) throw new SwitchboardError('switchboard_busy', 503);
    active++;
    try { return await fn(); }
    catch (e) { throw e instanceof SwitchboardError ? e : new SwitchboardError('switchboard_rpc_unavailable'); }
    finally { active--; }
  }
  async function inspect() {
    const snapshot = await load(connection());
    const unexpired = (c: Candidate) => c.eligibleUntilMs === undefined || now() < c.eligibleUntilMs;
    const candidates = snapshot.candidates.filter(c => c.eligible && unexpired(c));
    const discovery: { ok: boolean; gatewayCount: number; code?: string } = { ok: false, gatewayCount: 0 };
    let discovered: string[] = [];
    if (candidates.length) {
      try {
        discovered = parseGatewayRegistry(await registry(PROGRAM.toBase58() === 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv' ? 'mainnet' : 'devnet'));
        discovery.ok = true; discovery.gatewayCount = discovered.length;
      } catch (e) { discovery.code = e instanceof SwitchboardError ? e.code : 'switchboard_registry_unavailable'; }
    } else discovery.code = 'no_eligible_oracles';
    // Match SDK Queue.inspectRandomnessOracles: health snapshots may advertise ANY
    // oracle, not just the one owning that gateway URI. Ineligible oracles are never
    // selected, but their gateways can report health for eligible queue members.
    const ownBase = (uri: string) => { try { return gatewayBaseUrl(uri); } catch { return uri; } };
    const chainBases = [...new Set(snapshot.candidates.map(c => ownBase(c.gateway)))].slice(0, 16);
    const bases = [...new Set([...chainBases, ...discovered])];
    const probes = new Map<string, { code: string; raw?: unknown }>();
    // Up to 16 on-chain + 16 registry addresses, 8 requests at a time, 8s each.
    // Keep chain fallbacks even if the registry fills its entire budget.
    if (candidates.length) for (let offset = 0; offset < bases.length; offset += 8) {
      await Promise.all(bases.slice(offset, offset + 8).map(async uri => {
        try {
          const raw = await gateway(gatewayBaseUrl(uri), 'healthy_oracles');
          if (!raw || !Array.isArray((raw as { oracles?: unknown }).oracles)) throw new SwitchboardError('gateway_health_schema');
          probes.set(uri, { code: 'ok', raw });
        }
        catch (e) { probes.set(uri, { code: e instanceof SwitchboardError ? e.code : 'gateway_network' }); }
      }));
    }
    const sourceOf = (oracle: string) => [...probes].find(([, p]) => liveOracle(p.raw, oracle))?.[0];
    const healthy = candidates.filter(c => unexpired(c) && sourceOf(c.oracle) !== undefined);
    // Slow pool probes must not extend heartbeat/SGX validity or the positive cache.
    cacheDeadline = Math.min(Infinity, ...healthy.map(c => c.eligibleUntilMs ?? Infinity));
    return { ready: healthy.length > 0, checkedAt: new Date(now()).toISOString(), genesis: snapshot.genesis,
      program: PROGRAM.toBase58(), queue: QUEUE.toBase58(), oracle: healthy[0]?.oracle ?? null,
      queueMembers: snapshot.candidates.length, eligibleMembers: candidates.filter(unexpired).length, discovery,
      gatewayChecks: [...probes].map(([uri, p]) => ({ gateway: safeOrigin(uri), source: discovered.includes(uri) ? 'registry' : 'on_chain', code: p.code })),
      probes: candidates.map(c => {
        const source = unexpired(c) ? sourceOf(c.oracle) : undefined, directCode = probes.get(ownBase(c.gateway))?.code ?? 'not_probed';
        return { oracle: c.oracle, gateway: safeOrigin(c.gateway),
          healthGateway: source === undefined ? null : safeOrigin(source), directCode,
          healthy: source !== undefined, code: !unexpired(c) ? 'oracle_expired_during_probe' : source !== undefined ? 'ok' : directCode !== 'ok' ? directCode : 'oracle_not_live' };
      }) };
  }
  type Health = Awaited<ReturnType<typeof inspect>>;
  let cached: { until: number; value: Health } | undefined;
  let inFlight: Promise<Health> | undefined;
  async function health(): Promise<Health> {
    if (cached && cached.until > now()) return cached.value;
    if (!inFlight) {
      inFlight = limited(inspect).then(value => { cached = { until: Math.min(now() + 5000, cacheDeadline), value }; return value; }).finally(() => { inFlight = undefined; });
    }
    return inFlight;
  }
  async function reveal(address: string) {
    let key: PublicKey;
    try { key = new PublicKey(address); if (key.toBase58() !== address) throw new Error(); }
    catch { throw new SwitchboardError('bad_pubkey', 400); }
    return limited(async () => {
      const conn = connection();
      const info = await conn.getAccountInfo(key, 'confirmed');
      if (!info?.owner.equals(PROGRAM)) throw new SwitchboardError('switchboard_randomness_owner', 400);
      const rnd = decodeRandomness(info.data);
      if (!rnd.queue.equals(QUEUE) || ![RNG_KIND.PACK, RNG_KIND.BATTLE].some(kind => rnd.authority.equals(rngAuthPda(kind)[0]))) {
        throw new SwitchboardError('switchboard_randomness_binding', 400);
      }
      if (rnd.seedSlot === 0n || rnd.seedSlot > BigInt(Number.MAX_SAFE_INTEGER)) throw new SwitchboardError('switchboard_not_committed', 409);
      if (rnd.revealSlot > 0n) throw new SwitchboardError('switchboard_already_revealed', 409);
      const oracle = await conn.getAccountInfo(rnd.oracle, 'confirmed');
      if (!oracle?.owner.equals(PROGRAM) || oracle.data.length < 3504 || !new PublicKey(oracle.data.subarray(3472, 3504)).equals(QUEUE)) {
        throw new SwitchboardError('switchboard_oracle_binding', 400);
      }
      // Always the COMMITTED oracle. Never switch oracle/slothash to rescue a failed reveal.
      const raw = await gateway(gatewayBaseUrl(decodeOracleGateway(oracle.data)), 'randomness_reveal', {
        slothash: Array.from(rnd.seedSlothash), randomness_key: key.toBuffer().toString('hex'), slot: Number(rnd.seedSlot),
        rpc: PROGRAM.toBase58() === 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com',
      });
      return { randomness: address, oracle: rnd.oracle.toBase58(), queue: rnd.queue.toBase58(), ...revealPayload(raw) };
    });
  }
  return { health, reveal };
}
function safeOrigin(uri: string): string | null { try { return new URL(gatewayBaseUrl(uri)).origin; } catch { return null; } }
