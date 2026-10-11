import { ErrorNotice } from '@/shared/ui/ErrorNotice';
// /verify/:signature — provably-fair verifier. Recomputes the pack roll
// locally from the 32 randomness bytes with the SAME code the program uses
// (golden-vector tested against the Rust implementation). Live packs emit
// CompressedPackOpened (SlotHashes seed + rarities); legacy Core packs emit PackOpened.
import { useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQuery } from '@tanstack/react-query';
import { PACKS, QUEST_CHIP_TEMPLATES, expandRandomness, effectiveOdds } from '@guttercaps/economy';
import { usePackVerify } from '@/api/hooks';
import { findEvent } from '@/chain/anchor';
import {
  readPackOpened, readCompressedPackOpened, readCompressedClaimsCreated, decodeCompressedMintClaim,
  type PackOpenedEvent, type CompressedPackOpenedEvent,
} from '@/chain/accounts';
import { compressedMintClaimPda } from '@/chain/pdas';
import { toEconPack, voucherEconPack, fetchGameConfig } from '@/chain/flows/packFlow';
import { chipName, rarityColor, rarityName, collectionName, chipImageOf } from '@/shared/lib/rarity';
/** One row of the verification table: the API path fills `rarity` only, the chain path fills both (SEC-B6). */
type RollRow = { rarity?: number; collection?: number };
import { fmtPct, shortKey } from '@/shared/lib/format';
import { EXPLORER } from '@/app/config';
import { Skeleton } from '@/shared/ui/primitives';
import { CheckIcon, CrossIcon } from '@/shared/ui/action-icons';
import { ChipArt } from '@/shared/ui/ChipArt';
import { isMock } from '@/api/client';
import { useT } from '@/shared/i18n';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

type OpenKind = 'legacy' | 'compressed';
interface ChainOpen {
  kind: OpenKind;
  sku: number;
  count: number;
  roll: Uint8Array;
  pityBefore: number;
  rarities: number[];
  collections: number[];
  voucher: boolean;
  slot: number;
}

function fromLegacy(ev: PackOpenedEvent, slot: number): ChainOpen {
  return {
    kind: 'legacy', sku: ev.sku, count: ev.count, roll: ev.roll, pityBefore: ev.pityBefore,
    rarities: ev.rarities, collections: ev.collections, voucher: ev.sku === 0 && ev.count === 1, slot,
  };
}
function fromCompressed(ev: CompressedPackOpenedEvent, slot: number): ChainOpen {
  return {
    kind: 'compressed', sku: ev.sku, count: ev.count, roll: ev.roll, pityBefore: ev.pityBefore,
    rarities: ev.rarities, collections: ev.collections, voucher: ev.voucher, slot,
  };
}

export default function Verify() {
  const t = useT();
  const { signature = '' } = useParams();
  const nav = useNavigate();
  const [input, setInput] = useState(signature);
  const { connection } = useConnection();
  const api = usePackVerify(signature);

  const chain = useQuery({
    queryKey: ['verify', 'chain', signature],
    enabled: !!signature && !isMock(),
    queryFn: async () => {
      const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx?.meta?.logMessages) throw new Error('Transaction not found');
      const logs = tx.meta.logMessages;
      const slot = tx.slot;
      const packed = findEvent(logs, 'CompressedPackOpened', readCompressedPackOpened);
      if (packed) {
        const cfg = await fetchGameConfig(connection);
        return { open: fromCompressed(packed, slot), cfg, seedLogged: true as const };
      }
      const legacy = findEvent(logs, 'PackOpened', readPackOpened);
      if (legacy) {
        const cfg = await fetchGameConfig(connection);
        return { open: fromLegacy(legacy, slot), cfg, seedLogged: true as const };
      }
      const created = findEvent(logs, 'CompressedClaimsCreated', readCompressedClaimsCreated);
      if (created) {
        const claims = await Promise.all(created.claimNonces.map(async (n) => {
          const info = await connection.getAccountInfo(compressedMintClaimPda(created.buyer, n)[0], 'confirmed');
          return info ? decodeCompressedMintClaim(new Uint8Array(info.data)) : null;
        }));
        const minted = claims.filter((c): c is NonNullable<typeof c> => !!c);
        return {
          open: {
            kind: 'compressed' as const, sku: 0, count: minted.length, roll: new Uint8Array(0), pityBefore: 0,
            rarities: minted.map((c) => c.rarity), collections: minted.map((c) => c.collectionIdx),
            voucher: false, slot,
          },
          cfg: await fetchGameConfig(connection).catch(() => null),
          seedLogged: false as const,
        };
      }
      throw new Error('No PackOpened event in this transaction');
    },
    retry: 1,
  });

  const apiVoucher = api.data?.voucher ?? null;
  const local = useMemo(() => {
    const open = chain.data?.open;
    const cfg = chain.data?.cfg;
    if (!open || !chain.data?.seedLogged || !cfg) return null;
    const def = cfg.packs[open.sku];
    const all = Array.from({ length: cfg.collectionsCreated }, (_, i) => i);
    const onChain = open.rarities.map((r, i) => ({ rarity: r, collection: open.collections[i] }));
    const recompute = (econ: ReturnType<typeof toEconPack>, pool: number[]) => {
      const rolls = expandRandomness(open.roll, econ, open.pityBefore, pool.length).map((r) => ({ rarity: r.rarity, collection: pool[r.collectionIdx] }));
      return { rolls, matches: rolls.length === onChain.length && rolls.every((r, i) => r.rarity === onChain[i].rarity && r.collection === onChain[i].collection) };
    };
    if (open.voucher || (open.sku === 0 && open.count === 1 && def.chips !== 1)) {
      const candidates = apiVoucher?.odds ? [{ template: apiVoucher.template ?? -1, odds: apiVoucher.odds }] : QUEST_CHIP_TEMPLATES.map((tmpl, template) => ({ template, odds: [...tmpl.odds] }));
      const tried = candidates.map((c) => ({ ...c, econ: voucherEconPack({ voucherOdds: c.odds }), ...recompute(voucherEconPack({ voucherOdds: c.odds }), all) }));
      const hit = tried.find((c) => c.matches) ?? tried[0];
      return { rolls: hit.rolls, onChain, matches: hit.matches, odds: hit.odds, econ: hit.econ, voucher: { template: hit.template, fromApi: !!apiVoucher?.odds } };
    }
    const econ = toEconPack(open.sku, def);
    const pool = def.featuredOnly ? [cfg.featuredCollection] : all;
    return { ...recompute(econ, pool), onChain, odds: effectiveOdds(econ, open.pityBefore), econ, voucher: null };
  }, [chain.data, apiVoucher]);

  const claimsOnly = chain.data && !chain.data.seedLogged ? {
    rolls: chain.data.open.rarities.map((rarity, i) => ({ rarity, collection: chain.data!.open.collections[i] })),
    onChain: chain.data.open.rarities.map((rarity, i) => ({ rarity, collection: chain.data!.open.collections[i] })),
    matches: false,
    odds: PACKS.standard.oddsBps as unknown as number[],
    econ: PACKS.standard,
    voucher: null,
  } : null;

  const data = local ?? claimsOnly ?? (api.data ? {
    rolls: api.data.recomputed ?? [], onChain: api.data.onChain ?? [], matches: !!api.data.matches, odds: api.data.effectiveOddsBps ?? PACKS.standard.oddsBps as unknown as number[], econ: PACKS.standard,
    voucher: apiVoucher ? { template: apiVoucher.template ?? -1, fromApi: true } : null,
  } : null);
  const rollHex = chain.data?.seedLogged && chain.data.open.roll.length === 32 ? hex(chain.data.open.roll) : api.data?.rollHex;
  const pity = chain.data?.open.pityBefore ?? api.data?.pityBefore;
  const rolls: RollRow[] = (data?.rolls ?? []) as RollRow[];
  const unverifiable = !!claimsOnly && !local;

  return (
    <div className="page page-bg page-bg-verify stack">
      <div>
        <h1 className="page-title">{t('verify.title')}</h1>
        <p className="page-sub">{t('verify.subtitle')}</p>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); nav(`/verify/${input.trim()}`); }}>
        <input className="input mono" placeholder={t('ui.signature')} value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="btn" type="submit">{t('ui.verify')}</button>
      </form>
      <div className="tiny muted">{t('verify.slotHashes')} · <Link to="/drain">{t('drain.title')}</Link></div>

      {signature && (chain.isLoading || api.isLoading) && <Skeleton h={200} />}
      {signature && chain.error && api.error && <div className="danger"><ErrorNotice error={chain.error} /><div>{t('screens.backend')}:</div><ErrorNotice error={api.error} /></div>}

      {data && (
        <>
          <div className={unverifiable ? 'warn' : data.matches ? 'ok' : 'danger'} style={{ fontSize: 15 }}>
            {unverifiable
              ? t('screens.verifyNoSeed')
              : data.matches ? <> <CheckIcon size={13} /> {t('ui.verifyMatch')}</> : <> <CrossIcon size={13} /> {t('ui.verifyMismatch')}</>}
          </div>
          <div className="card stack-sm">
            <div className="row between small"><span className="muted">{t('ui.transaction')}</span><a className="mono" href={EXPLORER.tx(signature)} target="_blank" rel="noreferrer">{shortKey(signature, 8)} ↗</a></div>
            {chain.data && <div className="row between small"><span className="muted">{t('screens.openedSlot')}</span><span className="mono">{chain.data.open.slot}</span></div>}
            {chain.data && <div className="row between small"><span className="muted">{t('screens.verifyPath')}</span><span className="mono">{chain.data.open.kind === 'compressed' ? t('screens.verifyCompressed') : t('screens.originPack')}</span></div>}
            <div className="row between small"><span className="muted">{t('screens.pityBefore')}</span><span className="mono">{pity ?? '—'}</span></div>
            {data.voucher && <div className="row between small"><span className="muted">{t('screens.questVoucher')}</span><span className="mono">{t('screens.voucherTemplate', { n: data.voucher.template })}{data.voucher.fromApi ? '' : ` (${t('screens.inferred')})`}</span></div>}
            <div className="small muted">{t('screens.randomnessBytes')}</div>
            <div className="verify-hex mono">{rollHex ?? '—'}</div>
          </div>

          <div className="card stack-sm">
            <div className="strong">{t('screens.oddsThen')}</div>
            <div className="odds-legend">{data.odds.map((bps, r) => bps > 0 && <span key={r}><span style={{ color: rarityColor(r) }}>{rarityName(r)}</span> {fmtPct(bps, 2)}</span>)}</div>
            <div className="tiny muted"><code>rarity = rollRarity(uniformBps(bytes, i)); collection = pool[bytes[(5i+4) mod 32] mod |pool|]</code>. {t('screens.lastSlotRule')}</div>
          </div>

          <div className="card">
            <div className="table-scroll">
            <table className="table">
              <thead><tr><th>{t('ui.slot')}</th><th>{t('ui.recomputed')}</th><th>{t('ui.chainEvent')}</th><th></th></tr></thead>
              <tbody>
                {rolls.map((r, i) => {
                  const o = data.onChain[i];
                  const rar = r.rarity ?? -1;
                  const col = r.collection ?? o?.collection;
                  const ok = !unverifiable && !!o && o.rarity === rar && (r.collection === undefined || r.collection === o.collection);
                  return (
                    <tr key={i}>
                      <td className="mono">{i + 1}</td>
                      <td><span className="row"><span style={{ width: 42 }}><ChipArt collection={col ?? 0} rarity={rar} imageUrl={chipImageOf({ collection: col, rarity: rar })} /></span><span style={{ color: rarityColor(rar) }}>{rarityName(rar)}</span>{r.collection === undefined ? <span className="tiny muted"> {t('screens.districtChain')}</span> : <> · {collectionName(r.collection)}</>}</span></td>
                      <td>{o ? <><span style={{ color: rarityColor(o.rarity!) }}>{rarityName(o.rarity!)}</span> · {chipName(o.collection!, o.rarity!)}</> : '—'}</td>
                      <td style={{ color: ok ? 'var(--cg-acid-soft)' : 'var(--cg-magenta-soft)' }}>{unverifiable ? '—' : ok ? <CheckIcon size={13} /> : <CrossIcon size={13} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            {!chain.data && api.data && (
              <div className="tiny muted">
                {t('screens.apiVerify')}
              </div>
            )}
          </div>

          {rollHex && (
            <details className="card">
              <summary className="small">{t('screens.verifyNode')}</summary>
              <pre className="tiny mono" style={{ whiteSpace: 'pre-wrap' }}>{`git clone https://github.com/Leo88q/caps && cd caps/packages/economy && npm i
node --experimental-strip-types -e "
import('./src/index.ts').then(({ PACKS, expandRandomness }) => {
  const vrf = Uint8Array.from(Buffer.from('${rollHex}', 'hex'));
  console.log(expandRandomness(vrf, PACKS.${(['starter', 'standard', 'premium', 'limited'] as const)[chain.data?.open.sku ?? 1]}, ${pity ?? 0}, ${chain.data?.cfg?.collectionsCreated ?? 10}));
})"`}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}
