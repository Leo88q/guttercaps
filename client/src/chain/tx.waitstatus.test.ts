// The wait-status pill is how players learn "nothing broken, still working"
// during the two long tx pauses — lock the phase sequence sendTx reports.
import { Connection, Keypair } from '@solana/web3.js';
import { afterEach, expect, it, vi } from 'vitest';
import { clearWait, getWait, resetWaitForTest, setWait } from '@/shared/lib/waitStatus';
import { CHIP_CORE_ID } from './ids';
import { sendTx, TxError, type WalletLike } from './tx';

afterEach(() => resetWaitForTest());

function fixture() {
  const connection = {
    getLatestBlockhashAndContext: vi.fn().mockResolvedValue({ context: { slot: 100 }, value: { blockhash: CHIP_CORE_ID.toBase58(), lastValidBlockHeight: 123 } }),
    sendRawTransaction: vi.fn().mockResolvedValue('test-only'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    getTransaction: vi.fn().mockResolvedValue({ meta: { logMessages: [] } }),
  };
  const seen: string[] = [];
  const wallet: WalletLike = {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async (tx) => { seen.push(getWait()?.phase ?? 'none'); return tx; },
  };
  connection.sendRawTransaction.mockImplementation(() => { seen.push(getWait()?.phase ?? 'none'); return 'test-only'; });
  connection.confirmTransaction.mockImplementation(() => { seen.push(getWait()?.phase ?? 'none'); return { value: { err: null } }; });
  return { connection, wallet, seen };
}

it('reports prepare → wallet → send → confirm and clears when done', async () => {
  const { connection, wallet, seen } = fixture();
  await sendTx(connection as unknown as Connection, wallet, [], { cuLimit: 10_000, cuPrice: 1 });
  expect(seen).toEqual(['wallet', 'send', 'confirm']);
  expect(getWait()).toBeNull();
});

it('clears the pill when the wallet rejects', async () => {
  const { connection, wallet } = fixture();
  wallet.signTransaction = async () => { throw new Error('User rejected the request.'); };
  await expect(sendTx(connection as unknown as Connection, wallet, [], { cuLimit: 10_000, cuPrice: 1 })).rejects.toBeInstanceOf(TxError);
  expect(getWait()).toBeNull();
});

it('does not erase a non-tx phase that appears while a tx is in flight', async () => {
  const { connection, wallet } = fixture();
  // The wallet bridge flips to "connect" (e.g. adapter reconnect) right as the
  // tx enters confirmation; the phase-guarded clear in finally must keep it.
  connection.confirmTransaction.mockImplementation(() => { setWait('connect'); return { value: { err: null } }; });
  await sendTx(connection as unknown as Connection, wallet, [], { cuLimit: 10_000, cuPrice: 1 });
  expect(getWait()?.phase).toBe('connect');
  clearWait('connect');
});

it('opts.status=false keeps background flows off the pill', async () => {
  const { connection, wallet } = fixture();
  await sendTx(connection as unknown as Connection, wallet, [], { cuLimit: 10_000, cuPrice: 1, status: false });
  expect(getWait()).toBeNull();
});
