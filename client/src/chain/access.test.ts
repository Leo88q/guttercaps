import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { checkTransactionAccess, transactionFeatures } from './access';
import { CHIP_CORE_ID, MARKET_ID, STAKING_ID, ARENA_ID } from './ids';
import { ixData } from './anchor';
import { request, isMock } from '@/api/client';
vi.mock('@/api/client', () => ({ request: vi.fn(), isMock: vi.fn(() => false) }));
const ix = (name: string, programId = CHIP_CORE_ID) => new TransactionInstruction({ programId, keys: [], data: Buffer.from(ixData(name)) });
beforeEach(() => { vi.mocked(request).mockReset().mockResolvedValue({allowed:true}); vi.mocked(isMock).mockReturnValue(false); });
describe('first-party transaction guard', () => {
  for (const [name, program, feature] of [['buy_pack',CHIP_CORE_ID,'packs'],['pay_service',CHIP_CORE_ID,'services'],['fuse_claims_commit',CHIP_CORE_ID,'fusion'],['buy_compressed_asset',MARKET_ID,'market'],['make_offer',MARKET_ID,'market'],['stake_compressed_chip_v2',STAKING_ID,'staking'],['create_battle_v2',ARENA_ID,'arena'],['accept_battle',ARENA_ID,'arena']] as const) it(`classifies ${name}`, () => expect(transactionFeatures([ix(name,program)])).toEqual([feature]));
  for (const [name, program] of [['cancel_stale_pack',CHIP_CORE_ID],['fuse_claims_reveal',CHIP_CORE_ID],['open_pack',CHIP_CORE_ID],['finalize_compressed_pack',CHIP_CORE_ID],['cancel_offer',MARKET_ID],['cancel_compressed_asset',MARKET_ID],['unstake_cg',STAKING_ID],['unstake_compressed_chip',STAKING_ID],['claim_root',STAKING_ID],['cancel_stale_battle',ARENA_ID]] as const) it(`${name} needs no access API, even when it is down`, async () => {
    vi.mocked(request).mockRejectedValue(new Error('offline'));await checkTransactionAccess('wallet',[ix(name,program)]);expect(request).not.toHaveBeenCalled();
  });
  it('does not allow an exit instruction to exempt a purchase in the same transaction', () => expect(transactionFeatures([ix('cancel_stale_pack'),ix('buy_pack')])).toEqual(['packs']));
  it('checks the intended wallet and does not swallow server denial', async () => {
    const e=new Error('age_required');vi.mocked(request).mockRejectedValue(e);
    await expect(checkTransactionAccess('wallet',[ix('buy_pack')])).rejects.toBe(e);
    expect(request).toHaveBeenCalledWith('post','/me/compliance/check',{body:{wallet:'wallet',feature:'packs'}});
  });
  it('does not block a signing wallet when only the HTTP session is gone', async () => {
    vi.mocked(request).mockRejectedValue({ status: 401, code: 'unauthenticated' });
    await checkTransactionAccess('wallet', [ix('buy_pack')]);
    expect(request).toHaveBeenCalled();
  });
  it('does not exempt an unknown new managed instruction', () => expect(transactionFeatures([ix('future_purchase')])).toEqual(['services']));
  it('leaves unrelated program instructions alone', () => expect(transactionFeatures([ix('buy_pack',SystemProgram.programId)])).toEqual([]));
  it('does not contact a real API in explicit mock mode', async () => {vi.mocked(isMock).mockReturnValue(true);await checkTransactionAccess('wallet',[ix('buy_pack')]);expect(request).not.toHaveBeenCalled();});
});

it('denial prevents even transaction preparation and wallet prompting', async () => {
  const { sendTx } = await import('./tx');
  const connection = { getLatestBlockhash: vi.fn() };
  const wallet = { publicKey: CHIP_CORE_ID, signTransaction: vi.fn() };
  vi.mocked(request).mockRejectedValue(new Error('denied'));
  await expect(sendTx(connection as never, wallet as never, [ix('buy_pack')])).rejects.toThrow('denied');
  expect(connection.getLatestBlockhash).not.toHaveBeenCalled();expect(wallet.signTransaction).not.toHaveBeenCalled();
});
it('rechecks eligibility after preparation and before the wallet signs', async () => {
  const { sendTx } = await import('./tx');
  const connection = { getLatestBlockhash: vi.fn().mockResolvedValue({blockhash:SystemProgram.programId.toBase58(),lastValidBlockHeight:1}) };
  const wallet = { publicKey: CHIP_CORE_ID, signTransaction: vi.fn() };
  vi.mocked(request).mockResolvedValueOnce({allowed:true}).mockRejectedValueOnce(new Error('policy changed'));
  await expect(sendTx(connection as never,wallet as never,[ix('buy_pack')],{cuPrice:1,cuLimit:200000})).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(2);expect(wallet.signTransaction).not.toHaveBeenCalled();
});
