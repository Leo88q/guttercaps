import { BorshWriter } from '../src/borsh.ts';
// Exercise the real Anchor coder/name normalization used by SDK Program.at,
// not a fake `.idlAccount` API. External RPC/IDL download alone is replaced.
import { expect, it, vi } from 'vitest';
import { Program, BN, type Idl } from '@coral-xyz/anchor-31';
import { PublicKey, type Connection } from '@solana/web3.js';
import { accountDiscriminator } from '../src/chain.ts';
import { SWITCHBOARD_PROGRAM_ID, SWITCHBOARD_QUEUE } from '../src/config.ts';
import { FakeConnection, pk } from './chainFixtures.ts';
import { loadQueue } from '../src/switchboard.ts';

let program: Program;
vi.mock('@switchboard-xyz/on-demand', () => ({ AnchorUtils: { loadProgramFromConnection: vi.fn(async () => program) } }));
const queue = new PublicKey(SWITCHBOARD_QUEUE);
const idl: Idl = {
  address: SWITCHBOARD_PROGRAM_ID.toBase58(), metadata: { name: 'fixture', version: '1', spec: '0.1.0' }, instructions: [],
  accounts: ['QueueAccountData', 'OracleAccountData'].map(name => ({ name, discriminator: [...accountDiscriminator(name)] })),
  types: [
    { name: 'QueueAccountData', type: { kind: 'struct', fields: [
      { name: 'oracle_keys', type: { vec: 'pubkey' } }, { name: 'oracle_keys_len', type: 'u32' }, { name: 'node_timeout', type: 'u64' },
    ] } },
    { name: 'OracleAccountData', type: { kind: 'struct', fields: [
      { name: 'queue', type: 'pubkey' }, { name: 'is_on_queue', type: 'bool' }, { name: 'last_heartbeat', type: 'i64' },
      { name: 'enclave', type: { defined: { name: 'Enclave' } } },
      { name: 'padding', type: { array: ['u8', 3526] } }, { name: 'gateway_uri', type: { array: ['u8', 64] } },
    ] } },
    { name: 'Enclave', type: { kind: 'struct', fields: [{ name: 'verification_status', type: 'u8' }, { name: 'valid_until', type: 'i64' }] } },
  ],
};
async function fixture() {
  const conn = Object.assign(new FakeConnection(), { getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' });
  program = new Program(idl, { connection: conn as unknown as Connection });
  const oracle = pk();
  const q = await program.coder.accounts.encode('queueAccountData', { oracleKeys: [oracle], oracleKeysLen: 1, nodeTimeout: new BN(120) });
  conn.set(queue, q, SWITCHBOARD_PROGRAM_ID);
  const now = Math.floor(Date.now() / 1000);
  const gatewayUri = Buffer.alloc(64); gatewayUri.write('https://oracle.example.com');
  const data = { queue, isOnQueue: true, lastHeartbeat: new BN(now - 5), enclave: { verificationStatus: 4, validUntil: new BN(now + 500) }, padding: Buffer.alloc(3526), gatewayUri };
  async function store() {
    // Anchor's convenience encoder allocates only 1000 bytes; this fixture is 3648.
    const wire = new BorshWriter().bytes(accountDiscriminator('OracleAccountData')).pubkey(data.queue).bool(data.isOnQueue)
      .i64(BigInt(data.lastHeartbeat.toString())).u8(data.enclave.verificationStatus).i64(BigInt(data.enclave.validUntil.toString()))
      .bytes(data.padding).bytes(data.gatewayUri).toBytes();
    conn.set(oracle, wire, SWITCHBOARD_PROGRAM_ID);
  }
  await store();
  return { conn, oracle, data, store, read: () => loadQueue(conn as unknown as Connection) };
}
it('decodes the real Anchor account namespace and reads URI without Crossbar', async () => {
  const w = await fixture();
  expect((await w.read()).candidates).toEqual([{ oracle: w.oracle.toBase58(), gateway: 'https://oracle.example.com', eligible: true }]);
});
it.each(['stale', 'unverified', 'expired', 'off-queue', 'wrong-queue'] as const)('refuses %s on-chain oracle before live health selection', async reason => {
  const w = await fixture();
  if (reason === 'stale') w.data.lastHeartbeat = new BN(1);
  if (reason === 'unverified') w.data.enclave.verificationStatus = 0;
  if (reason === 'expired') w.data.enclave.validUntil = new BN(1);
  if (reason === 'off-queue') w.data.isOnQueue = false;
  if (reason === 'wrong-queue') w.data.queue = pk();
  await w.store();
  expect((await w.read()).candidates[0].eligible).toBe(false);
});
it('refuses wrong genesis and queue account owner', async () => {
  const w = await fixture(); w.conn.getGenesisHash = async () => 'wrong';
  await expect(w.read()).rejects.toMatchObject({ code: 'switchboard_cluster_mismatch' });
  w.conn.getGenesisHash = async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  w.conn.accounts.get(queue.toBase58())!.owner = pk();
  await expect(w.read()).rejects.toMatchObject({ code: 'switchboard_queue_owner' });
});
