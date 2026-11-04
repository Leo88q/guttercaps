// Регрессия находки 46 (последняя половина): истёкший несминченный клейм блокировал `finalize_compressed_pack`.
//
// `finalize` требует `registered_claims + cancelled_claims == total_claims`. Клейм живёт 7 дней; если его так
// и не сминчили, `settleChip` возвращал null, а `finalize` падал с «expired claims must be cancelled first».
// Отменить его мог только `cancel_compressed_claim` — он был методом флоу (`cancelClaim`) и не вызывался
// ниоткуда, поэтому доля покупки за этот клейм оставалась в эскроу расчёта навсегда.
//
// Теперь `finalizePack` сам снимает истёкшие клеймы перед финализацией. Проверяется именно поведение:
// с фейковой цепью два клейма покупки (один истёк, второй живой) дают РОВНО ОДНУ транзакцию отмены,
// и это `cancel_compressed_claim` с nonce истёкшего клейма.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { BorshWriter } from '@/chain/borsh';
import { accountDiscriminator, ixDiscriminator } from '@/chain/anchor';
import { compressedClaimNonce } from '@/chain/ix/chipCore';
import { PackFlow } from './packFlow';

// фабрика `vi.mock` поднимается к началу файла — шпион обязан жить в `vi.hoisted`
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/chain/tx', () => ({
  sendTx: mocks.send,
  appLookupTables: async () => [],
  fitsInTx: () => true,
  // WalletLike живёт типом, значение здесь не нужно
}));
const send = mocks.send;

const BUYER = Keypair.generate();

/** claim-аккаунт: settlement задан (клейм расчёта пака), срок — `expiresAt`. */
function claimBytes(expiresAt: bigint, settlement: PublicKey, flags: { minted?: boolean; consumed?: boolean; listed?: boolean; staked?: boolean } = {}) {
  return { data: new Uint8Array(new BorshWriter()
    .bytes(accountDiscriminator('CompressedMintClaim'))
    .pubkey(BUYER.publicKey).u8(0).u8(4).u8(1).u64(1n).i64(expiresAt)
    // порядок полей как в аккаунте: index_reserved, minted, registered, consumed, listed, bump, staked
    .pubkey(settlement).bool(false).bool(!!flags.minted).bool(false).bool(!!flags.consumed).bool(!!flags.listed)
    .u8(1).bool(!!flags.staked).pubkey(BUYER.publicKey).i64(0n)
    .toBytes()), lamports: 2_039_280 };
}

const now = Math.floor(Date.now() / 1000);
const SETTLEMENT = Keypair.generate().publicKey;

function makeFlow(qty: number, chips: number, getMultiple: ReturnType<typeof vi.fn>) {
  const flow = new PackFlow(
    { connection: { getMultipleAccountsInfo: getMultiple } as never, wallet: { publicKey: BUYER.publicKey, signTransaction: vi.fn() } as never, onState: () => undefined },
    { sku: 1, qty, currency: 0 as never, nonce: 77n },
  );
  // конфиг читается с цепи; здесь нужен только `chips` — количество клеймов на пак
  (flow as unknown as { cfg: unknown }).cfg = { packs: [null, { chips, enabled: true }] };
  return flow;
}

beforeEach(() => { send.mockReset(); send.mockResolvedValue({ signature: 'CANCELSIG', logs: [] }); });

describe('находка 46: finalize снимает истёкшие клеймы, а не запирает деньги', () => {
  it('отменяет ровно истёкший незабранный клейм и не трогает живой', async () => {
    const getMultiple = vi.fn(async (keys: PublicKey[]) => {
      // первый клейм истёк, второй ещё жив (окно 7 дней не вышло)
      expect(keys).toHaveLength(2);
      return [claimBytes(BigInt(now - 60), SETTLEMENT), claimBytes(BigInt(now + 86_400), SETTLEMENT)];
    });
    const flow = makeFlow(1, 2, getMultiple);
    const cancelled = await (flow as unknown as { cancelExpiredClaims: (p: unknown) => Promise<number> })
      .cancelExpiredClaims({ buyer: BUYER.publicKey, nonce: 77n, sku: 1, qty: 1, voucher: false });

    expect(cancelled).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    // sendTx(connection, wallet, instructions, opts)
    const ixs = (send.mock.calls[0] as unknown as [unknown, unknown, TransactionInstructionLike[]])[2]!;
    expect(Buffer.from(ixs[0]!.data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixDiscriminator('cancel_compressed_claim')).toString('hex'));
    // данные: u64 claim_nonce истёкшего клейма + u64 nonce покупки
    const dv = new DataView(ixs[0]!.data.buffer, ixs[0]!.data.byteOffset, ixs[0]!.data.byteLength);
    expect(dv.getBigUint64(8, true)).toBe(compressedClaimNonce(77n, 0, 0));
    expect(dv.getBigUint64(16, true)).toBe(77n);
  });

  it('не закрывает клейм в листинге, стейкинге, фьюжне или уже сминченный', async () => {
    // два пака по три клейма: в листинге, в стейкинге, израсходован, сминчен, бесплатный (фьюжн) и один
    // отсутствующий на цепи — ни один из них отменять нельзя
    const getMultiple = vi.fn(async () => [
      claimBytes(BigInt(now - 60), SETTLEMENT, { listed: true }),
      claimBytes(BigInt(now - 60), SETTLEMENT, { staked: true }),
      claimBytes(BigInt(now - 60), SETTLEMENT, { consumed: true }),
      claimBytes(BigInt(now - 60), SETTLEMENT, { minted: true }),
      claimBytes(BigInt(now - 60), PublicKey.default),
      null,
    ]);
    const flow = makeFlow(2, 3, getMultiple);
    const cancelled = await (flow as unknown as { cancelExpiredClaims: (p: unknown) => Promise<number> })
      .cancelExpiredClaims({ buyer: BUYER.publicKey, nonce: 77n, sku: 1, qty: 2, voucher: false });

    expect(cancelled).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

interface TransactionInstructionLike { data: Uint8Array }
