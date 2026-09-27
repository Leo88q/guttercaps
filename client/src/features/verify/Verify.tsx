// /verify/:signature — provably-fair verifier. Recomputes the pack roll
// locally from the 32 randomness bytes with the SAME code the program uses
// (golden-vector tested against the Rust implementation).
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQuery } from '@tanstack/react-query';
import { PACKS, QUEST_CHIP_TEMPLATES, expandRandomness, effectiveOdds } from '@guttercaps/economy';
import { usePackVerify } from '@/api/hooks';
import { findEvent } from '@/chain/anchor';
import { readPackOpened, type PackOpenedEvent } from '@/chain/accounts';
import { toEconPack, voucherEconPack, fetchGameConfig } from '@/chain/flows/packFlow';
import { RARITIES, chipName, rarityColor, rarityName, collectionName, chipImageOf } from '@/shared/lib/rarity';
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

export default function Verify() {
  const t = useT();
  const { signature = '' } = useParams();
  const nav = useNavigate();
  const [input, setInput] = useState(signature);
  const { connection } = useConnection();
  const api = usePackVerify(signature);

  // Independent path: read the transaction ourselves and decode PackOpened from logs.
  const chain = useQuery({
    queryKey: ['verify', 'chain', signature],
    enabled: !!signature && !isMock(),
    queryFn: async () => {
      const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!tx?.meta?.logMessages) throw new Error('Transaction not found');
      const ev = findEvent(tx.meta.logMessages, 'PackOpened', readPackOpened);
      if (!ev) throw new Error('No PackOpened event in this transaction');
      const cfg = await fetchGameConfig(connection);
      return { ev, cfg, slot: tx.slot };
    },
    retry: 1,
  });

  const apiVoucher = api.data?.voucher ?? null;
  const local = useMemo(() => {
    const ev: PackOpenedEvent | undefined = chain.data?.ev;
    if (!ev || !chain.data) return null;
    const def = chain.data.cfg.packs[ev.sku];
    const all = Array.from({ length: chain.data.cfg.collectionsCreated }, (_, i) => i);
    const onChain = ev.rarities.map((r, i) => ({ rarity: r, collection: ev.collections[i] }));
    const recompute = (econ: ReturnType<typeof toEconPack>, pool: number[]) => {
      const rolls = expandRandomness(ev.roll, econ, ev.pityBefore, pool.length).map((r) => ({ rarity: r.rarity, collection: pool[r.collectionIdx] }));
      return { rolls, matches: rolls.length === onChain.length && rolls.every((r, i) => r.rarity === onChain[i].rarity && r.collection === onChain[i].collection) };
    };
    // (#28) a quest cap voucher opens as sku 0 but mints ONE cap (the Starter is 3) with the voucher TEMPLATE odds, no floor / pity.
    // The template is pinned on-chain in the PendingPack (from the Merkle leaf); the API relays it from the VoucherIssued event —
    // without the API we try the 4 public templates and report which one reproduces the mint.
    if (ev.sku === 0 && ev.count === 1 && def.chips !== 1) {
      const candidates = apiVoucher?.odds ? [{ template: apiVoucher.template ?? -1, odds: apiVoucher.odds }] : QUEST_CHIP_TEMPLATES.map((t, template) => ({ template, odds: [...t.odds] }));
      const tried = candidates.map((c) => ({ ...c, econ: voucherEconPack({ voucherOdds: c.odds }), ...recompute(voucherEconPack({ voucherOdds: c.odds }), all) }));
      const hit = tried.find((c) => c.matches) ?? tried[0];
      return { rolls: hit.rolls, onChain, matches: hit.matches, odds: hit.odds, econ: hit.econ, voucher: { template: hit.template, fromApi: !!apiVoucher?.odds } };
    }
    const econ = toEconPack(ev.sku, def);
    const pool = def.featuredOnly ? [chain.data.cfg.featuredCollection] : all;
    return { ...recompute(econ, pool), onChain, odds: effectiveOdds(econ, ev.pityBefore), econ, voucher: null };
  }, [chain.data, apiVoucher]);

  const data = local ?? (api.data ? {
    rolls: api.data.recomputed ?? [], onChain: api.data.onChain ?? [], matches: !!api.data.matches, odds: api.data.effectiveOddsBps ?? PACKS.standard.oddsBps as unknown as number[], econ: PACKS.standard,
    voucher: apiVoucher ? { template: apiVoucher.template ?? -1, fromApi: true } : null,
  } : null);
  const rollHex = chain.data ? hex(chain.data.ev.roll) : api.data?.rollHex;
  const pity = chain.data?.ev.pityBefore ?? api.data?.pityBefore;
  /**
   * SEC-B6: the API now recomputes the RARITY sequence (it used to echo `matches: true` unconditionally) but
   * cannot recompute the district — the pool (`collections_created` / the featured district) is live chain
   * state the indexer does not mirror. So a row's `collection` is optional: the chain path above fills it from
   * the config account, the API path leaves it undefined and the row says who checked the district.
   */
  const rolls: RollRow[] = (data?.rolls ?? []) as RollRow[];

  return (
    <div className="page page-bg page-bg-verify stack">
      <div>
        <h1 className="page-title">{t('verify.title')}</h1>
        <p className="page-sub">{t('verify.subtitle')}</p>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); nav(`/verify/${input.trim()}`); }}>
        <input className="input mono" placeholder="transaction signature" value={input} onChange={(e) => setInput(e.target.value)} />
        <button className="btn" type="submit">Verify</button>
      </form>

      {signature && (chain.isLoading || api.isLoading) && <Skeleton h={200} />}
      {signature && chain.error && api.error && <div className="danger">{String((chain.error as Error).message)} · backend: {String((api.error as Error).message)}</div>}

      {data && (
        <>
          <div className={data.matches ? 'ok' : 'danger'} style={{ fontSize: 15 }}>
            {data.matches ? <> <CheckIcon size={13} /> Local recomputation matches the on-chain result.</> : <> <CrossIcon size={13} /> MISMATCH — the on-chain result does not follow from the randomness. Please report this.</>}
          </div>
          <div className="card stack-sm">
            <div className="row between small"><span className="muted">Transaction</span><a className="mono" href={EXPLORER.tx(signature)} target="_blank" rel="noreferrer">{shortKey(signature, 8)} ↗</a></div>
            {chain.data && <div className="row between small"><span className="muted">Opened in slot</span><span className="mono">{chain.data.slot}</span></div>}
            <div className="row between small"><span className="muted">Pity before</span><span className="mono">{pity}</span></div>
            {data.voucher && <div className="row between small"><span className="muted">Quest cap voucher</span><span className="mono">template {data.voucher.template}{data.voucher.fromApi ? '' : ' (inferred)'} · no floor / pity</span></div>}
            <div className="small muted">32 randomness bytes</div>
            <div className="verify-hex mono">{rollHex}</div>
          </div>

          <div className="card stack-sm">
            <div className="strong">Effective odds at that moment (per slot)</div>
            <div className="odds-legend">{data.odds.map((bps, r) => bps > 0 && <span key={r}><span style={{ color: rarityColor(r) }}>{RARITIES[r]}</span> {fmtPct(bps, 2)}</span>)}</div>
            <div className="tiny muted">Slot i: rarity = rollRarity(uniformBps(bytes, i)); collection = pool[bytes[(5i+4) mod 32] mod |pool|]; last slot gets the SKU floor and hard pity.</div>
          </div>

          <div className="card">
            <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Slot</th><th>Recomputed here</th><th>On-chain event</th><th></th></tr></thead>
              <tbody>
                {rolls.map((r, i) => {
                  const o = data.onChain[i];
                  const rar = r.rarity ?? -1;
                  const col = r.collection ?? o?.collection;
                  const ok = !!o && o.rarity === rar && (r.collection === undefined || r.collection === o.collection);
                  return (
                    <tr key={i}>
                      <td className="mono">{i + 1}</td>
                      <td><span className="row"><span style={{ width: 42 }}><ChipArt collection={col ?? 0} rarity={rar} imageUrl={chipImageOf({ collection: col, rarity: rar })} /></span><span style={{ color: rarityColor(rar) }}>{rarityName(rar)}</span>{r.collection === undefined ? <span className="tiny muted"> · district from the chain row</span> : <> · {collectionName(r.collection)}</>}</span></td>
                      <td>{o ? <><span style={{ color: rarityColor(o.rarity!) }}>{rarityName(o.rarity!)}</span> · {chipName(o.collection!, o.rarity!)}</> : '—'}</td>
                      <td style={{ color: ok ? 'var(--cg-acid-soft)' : 'var(--cg-magenta-soft)' }}>{ok ? <CheckIcon size={13} /> : <CrossIcon size={13} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            {!chain.data && api.data && (
              <div className="tiny muted">
                Recomputed by the API from the emitted randomness with the published pack table — rarities only: the
                district pool is live chain state, so read the on-chain column for districts. Open the transaction tab
                below (or run the snippet) to recompute everything, districts included, against the live config.
              </div>
            )}
          </div>

          <details className="card">
            <summary className="small">Verify independently (Node.js)</summary>
            <pre className="tiny mono" style={{ whiteSpace: 'pre-wrap' }}>{`git clone https://github.com/Leo88q/caps && cd caps/packages/economy && npm i
node --experimental-strip-types -e "
import('./src/index.ts').then(({ PACKS, expandRandomness }) => {
  const vrf = Uint8Array.from(Buffer.from('${rollHex ?? ''}', 'hex'));
  console.log(expandRandomness(vrf, PACKS.${(['starter', 'standard', 'premium', 'limited'] as const)[chain.data?.ev.sku ?? 1]}, ${pity ?? 0}, ${chain.data?.cfg.collectionsCreated ?? 10}));
})"`}</pre>
          </details>
        </>
      )}
    </div>
  );
}
