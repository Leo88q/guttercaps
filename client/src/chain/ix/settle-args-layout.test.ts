// Раскладка аргументов `settle_pack` / `grant_mint` — по исходнику программы, а не по памяти.
//
// Находка 79 (новая, при проверке контрактной части п. 3). `MintAuth` в программе — 8 полей
// (`wallet, order_id, amount, currency, order_slot, specs_hash, nonce, expires_at_slot`), а клиентские
// сборщики писали 7: `order_slot` в аргументах `settlePackIx`/`grantMintIx` отсутствовал. Последствия
// на цепи — не косметика: Anchor десериализует `SettleArgs` и читает `order_slot` из первых 8 байт
// `specs_hash`, дальше весь поток уезжает, `specs_hash` перестаёт совпадать с подписанным, а `specs`
// приходят из мусорного смещения. То есть фаза V не могла поселиться на цепи вообще — ни `settle_pack`,
// ни `grant_mint`. Гейт `npm run ix:shape` этого не видел: инструкции с именованным типом аргумента
// (`SettleArgs`) он объявляет «out of scope».
//
// Здесь поля берутся ИЗ `programs/settle/src/lib.rs` (порядок и типы), и сборщик обязан уложить их
// байт в байт. Тест падает на любом пропущенном/переставленном поле, даже если `ix:shape` молчит.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { BorshReader } from '@/chain/borsh';
import { ixData } from '@/chain/anchor';
import { grantMintIx, oracleAuthIx, settlePackIx, type SettlePayloadLike } from './settle';

const root = path.resolve(process.cwd(), process.cwd().endsWith('/client') ? '..' : '.');
const rust = readFileSync(path.join(root, 'programs/settle/src/lib.rs'), 'utf8');

/** `pub struct Name { field: Type, … }` → [имя поля, тип] в порядке объявления. */
function structFields(name: string): [string, string][] {
  const m = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`).exec(rust);
  if (!m) throw new Error(`программа не содержит struct ${name}`);
  return m[1]!.split('\n')
    .map((l) => /^\s*pub (\w+):\s*([A-Za-z0-9_\[\]; ]+?),?\s*$/.exec(l))
    .filter((x): x is RegExpExecArray => !!x)
    .map((x) => [x[1]!, x[2]!.trim()] as [string, string]);
}

const AUTH = structFields('MintAuth');
const SPEC = structFields('LeafSpec');

/** Тип поля Rust → чтение того же значения из потока (borsh, little-endian). */
function read(r: BorshReader, ty: string): unknown {
  if (ty === 'Pubkey') return r.pubkey();
  if (ty === 'u64') return r.u64();
  if (ty === 'u8') return r.u8();
  if (ty === 'i64') return r.i64();
  if (ty === '[u8; 32]') return Buffer.from(r.bytes(32)).toString('hex');
  if (ty === 'String') return r.string();
  throw new Error(`тип ${ty} не описан в тесте`);
}

const oracle = Keypair.generate();
const buyer = Keypair.generate().publicKey;
const collection = Keypair.generate().publicKey;

const auth = {
  wallet: buyer.toBase58(),
  orderId: (1n << 63n) + 5n,
  amount: 5_990_000n,
  currency: 0,
  orderSlot: 987_654n,
  specsHash: '11'.repeat(32),
  nonce: (1n << 63n) + 5n,
  expiresAtSlot: 999_999_999n,
};

const payload: SettlePayloadLike = {
  program: Keypair.generate().publicKey.toBase58(),
  oracle: oracle.publicKey.toBase58(),
  config: Keypair.generate().publicKey.toBase58(),
  treeAuth: Keypair.generate().publicKey.toBase58(),
  tree: Keypair.generate().publicKey.toBase58(),
  treeConfig: Keypair.generate().publicKey.toBase58(),
  orderPda: Keypair.generate().publicKey.toBase58(),
  grantReceipt: Keypair.generate().publicKey.toBase58(),
  auth: Object.fromEntries(Object.entries(auth).map(([k, v]) => [k, String(v)])) as unknown as SettlePayloadLike['auth'],
  signature: '1'.repeat(64),
  specs: [{ collection: collection.toBase58(), name: 'Gutter Caps #1', symbol: 'GCAP', uri: 'https://x/1.json' }],
};

/** Ожидаемые значения по имени поля — то, что обязано оказаться в потоке. */
const expected: Record<string, unknown> = {
  wallet: buyer,
  order_id: auth.orderId,
  amount: auth.amount,
  currency: auth.currency,
  order_slot: auth.orderSlot,
  specs_hash: auth.specsHash,
  nonce: auth.nonce,
  expires_at_slot: auth.expiresAtSlot,
};

describe('находка 79: раскладка MintAuth в аргументах совпадает с программой', () => {
  it('Rust описывает 8 полей, включая order_slot (находка 16)', () => {
    expect(AUTH.map(([n]) => n)).toEqual([
      'wallet', 'order_id', 'amount', 'currency', 'order_slot', 'specs_hash', 'nonce', 'expires_at_slot',
    ]);
    expect(SPEC.map(([n]) => n)).toEqual(['collection', 'name', 'symbol', 'uri']);
  });

  for (const [label, build] of [
    ['settle_pack', () => settlePackIx(payload, { relayer: Keypair.generate().publicKey, treasury: Keypair.generate().publicKey })],
    ['grant_mint', () => grantMintIx(payload, { relayer: Keypair.generate().publicKey })],
  ] as const) {
    it(`${label}: auth читается без остатка, specs начинаются ровно за ним`, () => {
      const ix = build();
      const data = new Uint8Array(ix.data);
      const r = new BorshReader(data, 8); // после anchor-дискриминатора
      if (label === 'settle_pack') expect(r.u64()).toBe(auth.orderId); // отдельный аргумент `order_id`
      const seen: Record<string, unknown> = {};
      for (const [name, ty] of AUTH) seen[name] = read(r, ty);
      // ни одного пропущенного поля: каждое на своём месте со своим значением
      for (const [name] of AUTH) expect(seen[name], `поле ${name}`).toEqual(expected[name]);
      // и specs decode-ятся из правильного смещения — это и ломалось при пропущенном order_slot
      const specs = r.vec(() => Object.fromEntries(SPEC.map(([n, ty]) => [n, read(r, ty)])));
      expect(specs).toEqual([{
        collection, name: payload.specs[0]!.name, symbol: payload.specs[0]!.symbol, uri: payload.specs[0]!.uri,
      }]);
      // ни одного лишнего байта: иначе программа прочитает мусор после specs
      expect(r.remaining).toBe(0);
    });
  }

  it('подписанное сообщение — тот же порядок байт, что mint_auth_message в программе', () => {
    const ix = oracleAuthIx(payload);
    const data = new Uint8Array(ix.data);
    // заголовок ed25519-инструкции: num_signatures, padding, затем смещения (14 байт)
    expect(data[0]).toBe(1);
    const msgOff = new DataView(data.buffer, data.byteOffset).getUint16(10, true);
    const msgLen = new DataView(data.buffer, data.byteOffset).getUint16(12, true);
    const msg = data.subarray(msgOff, msgOff + msgLen);
    const prefix = 'GUTCAP/MINTAUTH/V2';
    expect(Buffer.from(msg.subarray(0, prefix.length)).toString()).toBe(prefix);
    const r = new BorshReader(msg.subarray(prefix.length));
    const seen: Record<string, unknown> = {};
    for (const [name, ty] of AUTH) seen[name] = read(r, ty);
    for (const [name] of AUTH) expect(seen[name], `поле ${name} в подписи`).toEqual(expected[name]);
    expect(r.remaining).toBe(0); // ровно 105 байт после домена, как в `mint_auth_message`
  });
});
