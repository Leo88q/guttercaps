import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { diagnoseRpc } from './rpcDiagnostics';

const endpoint = 'https://rpc.invalid/private-path?api-key=DO-NOT-PRINT';
const hash = Keypair.generate().publicKey.toBase58();
const finalizedHash = Keypair.generate().publicKey.toBase58();
const freshHash = Keypair.generate().publicKey.toBase58();
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());

function fixture(invalidImmediately = false) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
    expect(url).toBe(endpoint);
    const request = JSON.parse(String(init?.body)); calls.push(request);
    let result: unknown;
    const later = Date.now() >= 45000;
    switch (request.method) {
      case 'getGenesisHash': result = genesis; break;
      case 'getLatestBlockhash': {
        const isFinalized = request.params[0].commitment === 'finalized';
        result = { context: { slot: later ? 2000 : 1000 }, value: {
          blockhash: isFinalized ? finalizedHash : later ? freshHash : hash,
          lastValidBlockHeight: later ? 350 : isFinalized ? 180 : 200,
        } };
        break;
      }
      case 'isBlockhashValid':
        expect(request.params[1]).toEqual({ commitment: 'confirmed', minContextSlot: 1000 });
        result = { context: { slot: later ? 2000 : 1000 }, value: !later && !(invalidImmediately && request.params[0] === hash) };
        break;
      case 'getBlockHeight': result = later ? 220 : 100; break;
      default: throw new Error(`Not a permitted read-only method: ${request.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  return { fetchImpl, calls };
}

it('tracks the SAME hashes for 45 seconds, reports block-height expiry, and never asks for a transaction', async () => {
  const f = fixture();
  const result = diagnoseRpc(endpoint, { fetchImpl: f.fetchImpl, signal: new AbortController().signal, cluster: 'devnet' });
  await vi.advanceTimersByTimeAsync(44999);
  expect(f.calls).toHaveLength(7);
  await vi.advanceTimersByTimeAsync(1);
  const report = await result;
  expect(report.isDevnet).toBe(true);
  expect(report.immediate.confirmed).toMatchObject({ remainingBlocks: 100, validity: { ok: true, value: { valid: true } } });
  expect(report.delayed.confirmed).toMatchObject({ remainingBlocks: -20, validity: { ok: true, value: { valid: false } } });
  expect(report.freshConfirmed).toMatchObject({ ok: true, value: { blockhash: freshHash } });
  expect(f.calls).toHaveLength(12);
  expect(JSON.stringify(report)).not.toMatch(/DO-NOT-PRINT|rpc\.invalid|private-path/);
  expect(vi.getTimerCount()).toBe(0);
});

it('shows immediate disagreement separately from expiry instead of guessing its cause', async () => {
  const f = fixture(true);
  const result = diagnoseRpc(endpoint, { fetchImpl: f.fetchImpl, signal: new AbortController().signal, cluster: 'devnet' });
  await vi.advanceTimersByTimeAsync(45000);
  const report = await result;
  expect(report.immediate.confirmed).toMatchObject({ remainingBlocks: 100, validity: { value: { valid: false } } });
  expect(report.immediate.finalized).toMatchObject({ remainingBlocks: 80, validity: { value: { valid: true } } });
});

it.each([401, 429])('reports HTTP %s without retrying or exposing provider prose / credentials', async status => {
  const fetchImpl = vi.fn(async () => new Response(endpoint, { status }));
  const report = await diagnoseRpc(endpoint, { fetchImpl, signal: new AbortController().signal, cluster: 'devnet' });
  expect(report.confirmed).toMatchObject({ ok: false, error: { kind: 'http', status } });
  expect(report.delayed.confirmed).toBeNull();
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(report)).not.toContain(endpoint);
  expect(vi.getTimerCount()).toBe(0);
});

it('omits raw RPC error messages and returns only the error code', async () => {
  const report = await diagnoseRpc(endpoint, { signal: new AbortController().signal, cluster: 'devnet',
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: -32016, message: endpoint, data: { key: 'DO-NOT-PRINT' } } })),
  });
  expect(report.confirmed).toMatchObject({ ok: false, error: { kind: 'rpc', code: -32016 } });
  expect(JSON.stringify(report)).not.toMatch(/DO-NOT-PRINT|rpc\.invalid|private-path/);
});

it('cancels the wait and makes no delayed requests after cancellation', async () => {
  const f = fixture(), controller = new AbortController();
  const result = diagnoseRpc(endpoint, { signal: controller.signal, cluster: 'devnet', fetchImpl: f.fetchImpl });
  const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort();
  await rejection;
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.calls).toHaveLength(7);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds hung reads and removes endpoint text from network exceptions', async () => {
  const fetchImpl: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error(endpoint)), { once: true });
  });
  const result = diagnoseRpc(endpoint, { signal: new AbortController().signal, cluster: 'devnet', fetchImpl });
  await vi.advanceTimersByTimeAsync(36000);
  const report = await result;
  expect(report.genesis).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  expect(report.confirmed).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  expect(JSON.stringify(report)).not.toContain(endpoint);
  expect(vi.getTimerCount()).toBe(0);
});
