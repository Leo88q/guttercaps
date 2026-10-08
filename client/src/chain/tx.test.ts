import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, TransactionInstruction } from '@solana/web3.js';
import { sendTx, TxError, type WalletLike } from './tx';
import { checkTransactionAccess } from './access';
import { errorSnapshot } from './errorSnapshot';
vi.mock('./access', () => ({ checkTransactionAccess: vi.fn(async () => {}) }));
beforeEach(() => vi.clearAllMocks());

function fixture() {
  const hash = Keypair.generate().publicKey.toBase58();
  const connection = {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: hash, lastValidBlockHeight: 123 })),
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
  it('obtains the signing blockhash AFTER simulation and the last compliance round trip', async () => {
    const f = fixture();
    await sendTx(f.connection as unknown as Connection, f.wallet, [], { cuPrice: 1 });
    const fetchOrder = f.connection.getLatestBlockhash.mock.invocationCallOrder[0];
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
