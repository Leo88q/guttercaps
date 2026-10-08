import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, SendTransactionError, TransactionInstruction, VersionedTransaction, type FetchFn } from '@solana/web3.js';
import { sendTx, TxError, type WalletLike } from './tx';
import { checkTransactionAccess } from './access';
import { errorSnapshot } from './errorSnapshot';
import { base58Encode } from '@/shared/lib/base58';
vi.mock('./access', () => ({ checkTransactionAccess: vi.fn(async () => {}) }));
beforeEach(() => vi.clearAllMocks());

function fixture() {
  const hash = Keypair.generate().publicKey.toBase58();
  const connection = {
    getLatestBlockhashAndContext: vi.fn(async () => ({ context: { slot: 100 }, value: { blockhash: hash, lastValidBlockHeight: 123 } })),
    simulateTransaction: vi.fn(async () => ({ value: { err: null, unitsConsumed: 120000 } })),
    sendRawTransaction: vi.fn(async () => 'test-only'),
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    getSignatureStatuses: vi.fn(async () => ({ value: [null] } as { value: ({ err: null | object; confirmationStatus: string } | null)[] })),
    getTransaction: vi.fn(async () => ({ meta: { logMessages: ['confirmed'] } })),
  };
  const signer = Keypair.generate();
  const wallet: WalletLike = { publicKey: signer.publicKey, signTransaction: vi.fn(async tx => { tx.sign([signer]); return tx; }) };
  return { connection, wallet, hash };
}

describe('transaction freshness and safe confirmation recovery', () => {
  it('keeps an instruction snapshot context floor even if a stale RPC replies with an older context', async () => {
    const f = fixture();
    await sendTx(f.connection as unknown as Connection, f.wallet, [], { cuLimit: 100000, cuPrice: 1, minContextSlot: 200 });
    expect(f.connection.getLatestBlockhashAndContext).toHaveBeenCalledWith({ commitment: 'confirmed', minContextSlot: 200 });
    expect(f.connection.sendRawTransaction).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({ minContextSlot: 200 }));
  });
  it('obtains the signing blockhash AFTER simulation and the last compliance round trip', async () => {
    const f = fixture();
    await sendTx(f.connection as unknown as Connection, f.wallet, [], { cuPrice: 1 });
    const fetchOrder = f.connection.getLatestBlockhashAndContext.mock.invocationCallOrder[0];
    expect(fetchOrder).toBeGreaterThan(f.connection.simulateTransaction.mock.invocationCallOrder[0]);
    expect(fetchOrder).toBeGreaterThan(vi.mocked(checkTransactionAccess).mock.invocationCallOrder.at(-1)!);
    expect(fetchOrder).toBeLessThan(vi.mocked(f.wallet.signTransaction).mock.invocationCallOrder[0]);
    expect(vi.mocked(f.wallet.signTransaction).mock.calls[0][0].message.recentBlockhash).toBe(f.hash);
  });
  it('recovers an already confirmed stake when confirmTransaction reports expiry, without staking twice', async () => {
    const f = fixture();
    f.connection.confirmTransaction.mockRejectedValue(new Error('block height exceeded'));
    f.connection.getSignatureStatuses.mockResolvedValue({ value: [{ err: null, confirmationStatus: 'confirmed' }] });
    await expect(sendTx(f.connection as unknown as Connection, f.wallet, [], { cuLimit: 250000, cuPrice: 1 })).resolves.toHaveProperty('signature');
    expect(f.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(f.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it('keeps an unresolved submitted signature and never automatically sends a second stake', async () => {
    const f = fixture();
    f.connection.confirmTransaction.mockRejectedValue(new Error('block height exceeded'));
    const error = await sendTx(f.connection as unknown as Connection, f.wallet, [], { cuLimit: 250000, cuPrice: 1 }).catch(e => e);
    expect(error).toBeInstanceOf(TxError);
    expect(error.signature).toBeTruthy();
    expect(errorSnapshot(error).code).toBe('confirmation_unknown');
    expect(f.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(f.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it.each(['Blockhash not found', 'Failed to fetch'])('does not replay a send attempt after an ambiguous RPC error: %s', async message => {
    const f = fixture();
    f.connection.sendRawTransaction.mockRejectedValue(new Error(message));
    const error = await sendTx(f.connection as unknown as Connection, f.wallet, [], { cuLimit: 250000, cuPrice: 1 }).catch(e => e);
    expect(errorSnapshot(error).code).toBe('confirmation_unknown');
    expect(error.signature).toBeTruthy();
    expect(f.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(f.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it('recovers a landed stake even if its send HTTP response was lost', async () => {
    const f = fixture();
    f.connection.sendRawTransaction.mockRejectedValue(new Error('Failed to fetch'));
    f.connection.getSignatureStatuses.mockResolvedValue({ value: [{ err: null, confirmationStatus: 'confirmed' }] });
    await expect(sendTx(f.connection as unknown as Connection, f.wallet, [], { cuLimit: 250000, cuPrice: 1 })).resolves.toHaveProperty('signature');
    expect(f.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(f.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it('reports the actual on-chain failure if reconciliation finds a failed transaction', async () => {
    const f = fixture();
    f.connection.confirmTransaction.mockRejectedValue(new Error('block height exceeded'));
    f.connection.getSignatureStatuses.mockResolvedValue({ value: [{ err: { InstructionError: [1, { Custom: 6000 }] }, confirmationStatus: 'confirmed' }] });
    await expect(sendTx(f.connection as unknown as Connection, f.wallet, [], { cuLimit: 250000, cuPrice: 1 })).rejects.toThrow(/custom program error/);
    expect(f.wallet.signTransaction).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized packets before the wallet, with a useful error instead of encoding overruns', async () => {
    const f = fixture();
    const ix = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(1400) });
    await expect(sendTx(f.connection as unknown as Connection, f.wallet, [ix], { cuLimit: 250000 })).rejects.toThrow(/1232-byte packet limit/);
    expect(f.wallet.signTransaction).not.toHaveBeenCalled();
  });
});

// Exercise the SDK's JSON-RPC error decoder, not merely Error('Blockhash not found').
// This is the exact -32002/preflight response behind the user's screenshot.
describe('real RPC serialization: rejected preflight is not unknown confirmation', () => {
  it.each(['once', 'always'] as const)('handles a blockhash rejected %s, with at most two approvals', async rejection => {
    const signer = Keypair.generate();
    const hashes = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
    const calls: { method: string; params: unknown[] }[] = [];
    const sent: VersionedTransaction[] = [];
    let latest = 0;
    const rpcFetch: FetchFn = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      calls.push(request);
      let response: object;
      if (request.method === 'getLatestBlockhash') {
        response = { result: { context: { slot: 101 + latest }, value: { blockhash: hashes[latest++], lastValidBlockHeight: 500 } } };
      } else if (request.method === 'sendTransaction') {
        sent.push(VersionedTransaction.deserialize(Buffer.from(request.params[0], 'base64')));
        response = rejection === 'always' || sent.length === 1
          ? { error: { code: -32002, message: 'Transaction simulation failed: Blockhash not found', data: { err: 'BlockhashNotFound', logs: [] } } }
          : { result: base58Encode(sent.at(-1)!.signatures[0]) };
      } else throw new Error(`Unexpected RPC: ${request.method}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }), { status: 200 }) as Awaited<ReturnType<FetchFn>>;
    };
    const connection = new Connection('http://rpc.test', { fetch: rpcFetch });
    const confirm = vi.spyOn(connection, 'confirmTransaction').mockResolvedValue({ context: { slot: 103 }, value: { err: null } });
    vi.spyOn(connection, 'getTransaction').mockResolvedValue(null);
    const status = vi.spyOn(connection, 'getSignatureStatuses');
    const wallet: WalletLike = { publicKey: signer.publicKey, signTransaction: vi.fn(async tx => { tx.sign([signer]); return tx; }) };
    const onSent = vi.fn();
    const result = await sendTx(connection, wallet, [], { cuLimit: 120000, cuPrice: 1, onSent }).catch(e => e);
    expect(wallet.signTransaction).toHaveBeenCalledTimes(2);
    expect(sent.map(tx => tx.message.recentBlockhash)).toEqual(hashes);
    expect(base58Encode(sent[0].signatures[0])).not.toBe(base58Encode(sent[1].signatures[0]));
    expect(calls.filter(c => c.method === 'sendTransaction').map(c => c.params[1])).toEqual([
      expect.objectContaining({ minContextSlot: 101, preflightCommitment: 'confirmed' }),
      expect.objectContaining({ minContextSlot: 102, preflightCommitment: 'confirmed' }),
    ]);
    expect(calls.filter(c => c.method === 'getLatestBlockhash')[1].params[0]).toMatchObject({ commitment: 'confirmed', minContextSlot: 101 });
    expect(status).not.toHaveBeenCalled(); // the RPC explicitly rejected these attempts before execution
    if (rejection === 'once') {
      expect(result.signature).toBe(base58Encode(sent[1].signatures[0]));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(onSent).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toBeInstanceOf(TxError);
      expect(result.signature).toBeUndefined();
      expect(errorSnapshot(result).code).toBe('blockhash_rejected');
      expect(errorSnapshot(result).details).toMatchObject({ stage: 'preflight', attempts: 2, minContextSlot: 102 });
      expect(confirm).not.toHaveBeenCalled();
      expect(onSent).not.toHaveBeenCalled();
    }
  });
  it('does not assume a simulation rejection when preflight was disabled', async () => {
    const f = fixture();
    f.connection.sendRawTransaction.mockRejectedValue(new SendTransactionError({ action: 'send', signature: '', transactionMessage: 'Transaction simulation failed: Blockhash not found', logs: [] }));
    const error = await sendTx(f.connection as unknown as Connection, f.wallet, [], { cuLimit: 120000, cuPrice: 1, skipPreflight: true }).catch(e => e);
    expect(errorSnapshot(error).code).toBe('confirmation_unknown');
    expect(f.wallet.signTransaction).toHaveBeenCalledTimes(1);
  });
  it('does not retry an explicit program rejection or show a pending-transaction link', async () => {
    const f = fixture();
    f.connection.sendRawTransaction.mockRejectedValue(new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1770', logs: ['Program failed: custom program error: 0x1770'] }));
    const error = await sendTx(f.connection as unknown as Connection, f.wallet, [], { cuLimit: 120000, cuPrice: 1 }).catch(e => e);
    expect(errorSnapshot(error).code).not.toBe('confirmation_unknown');
    expect(error.signature).toBeUndefined();
    expect(f.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(f.connection.getSignatureStatuses).not.toHaveBeenCalled();
  });
});
