// Read-only probe of the ACTIVE browser RPC. No wallet, transaction builder,
// send/simulate method, provider error prose or endpoint URL enters the report.
import { sha256 } from '@noble/hashes/sha256';

type Method = 'getGenesisHash' | 'getLatestBlockhash' | 'getBlockHeight' | 'isBlockhashValid';
type Failure = { kind: 'http' | 'rpc' | 'network' | 'timeout' | 'schema'; status?: number; code?: number };
type Result<T> = { ok: true; value: T; ms: number } | { ok: false; error: Failure; ms: number };
type Hash = { blockhash: string; lastValidBlockHeight: number; contextSlot: number };
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const hashString = (v: unknown): v is string => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function diagnoseRpc(endpoint: string, opts: {
  signal: AbortSignal; cluster: string; fetchImpl?: typeof fetch; waitMs?: number;
}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const fingerprint = Array.from(sha256(new TextEncoder().encode(endpoint)), x => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
  let id = 0;
  async function call<T>(method: Method, params: unknown[], parse: (value: unknown) => T | undefined): Promise<Result<T>> {
    if (opts.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const at = Date.now(), controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    opts.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    const fail = (error: Failure): Result<T> => ({ ok: false, error, ms: Date.now() - at });
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: controller.signal, cache: 'no-store', redirect: 'error' });
      if (!response.ok) return fail({ kind: 'http', status: response.status });
      let json: Record<string, unknown>;
      try { json = object(await response.json()); } catch {
        if (opts.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        return fail({ kind: timedOut ? 'timeout' : 'schema' });
      }
      if (json.error != null) {
        const code = object(json.error).code;
        return fail({ kind: 'rpc', ...(typeof code === 'number' && Number.isSafeInteger(code) ? { code } : {}) });
      }
      const value = parse(json.result);
      return value === undefined ? fail({ kind: 'schema' }) : { ok: true, value, ms: Date.now() - at };
    } catch {
      if (opts.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      return fail({ kind: timedOut ? 'timeout' : 'network' });
    } finally {
      clearTimeout(timer); opts.signal.removeEventListener('abort', abort);
    }
  }
  const latest = (commitment: 'confirmed' | 'finalized') => call<Hash>('getLatestBlockhash', [{ commitment }], raw => {
    const result = object(raw), value = object(result.value), slot = object(result.context).slot;
    return hashString(value.blockhash) && integer(value.lastValidBlockHeight) && integer(slot)
      ? { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight, contextSlot: slot } : undefined;
  });
  const genesis = await call('getGenesisHash', [], raw => hashString(raw) ? raw : undefined);
  const confirmed = await latest('confirmed');
  const finalized = await latest('finalized');
  const probe = async (source: Result<Hash>) => {
    if (!source.ok) return null;
    const { blockhash, lastValidBlockHeight, contextSlot } = source.value;
    const config = { commitment: 'confirmed', minContextSlot: contextSlot };
    const elapsedMs = Date.now() - started;
    const validity = await call('isBlockhashValid', [blockhash, config], raw => {
      const result = object(raw), slot = object(result.context).slot;
      return typeof result.value === 'boolean' && integer(slot) ? { valid: result.value, contextSlot: slot } : undefined;
    });
    const height = await call('getBlockHeight', [config], raw => integer(raw) ? raw : undefined);
    return { elapsedMs, validity, height, remainingBlocks: height.ok ? lastValidBlockHeight - height.value : null };
  };
  const immediate = { confirmed: await probe(confirmed), finalized: await probe(finalized) };
  // Wait only when there is a real hash to track; an HTTP 401 should return promptly.
  if (confirmed.ok || finalized.ok) await wait(opts.waitMs ?? 45000, opts.signal);
  const delayed = { confirmed: await probe(confirmed), finalized: await probe(finalized) };
  const freshConfirmed = confirmed.ok || finalized.ok ? await latest('confirmed') : null;
  return {
    version: 1, endpointFingerprint: fingerprint, startedAt: new Date(started).toISOString(), totalMs: Date.now() - started,
    expectedCluster: ['devnet', 'mainnet-beta', 'localnet'].includes(opts.cluster) ? opts.cluster : 'unknown',
    genesis, isDevnet: genesis.ok ? genesis.value === DEVNET_GENESIS : null,
    confirmed, finalized, immediate, delayed, freshConfirmed,
  };
}
