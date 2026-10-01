import { joinText } from '@/shared/i18n/message';
import type { MessageKey } from '@/shared/i18n';
import { useT, fmtLocale } from '@/shared/i18n';
// Detail + actions for one owned chip: list on market, stake, send to bench, thaw.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import type { Chip } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { sendTx } from '@/chain/tx';
import { resolveCompressedChip, resolveCompressedChipIdentity } from '@/chain/flows/compressedChip';
import { thawChipIx } from '@/chain/ix/chipCore';
import { stakeCompressedChipV2Ix, unstakeCompressedChipIx } from '@/chain/ix/staking';
import { dasClient } from '@/features/market/payment';
import { createAtaIdempotentIx } from '@/chain/ix/spl';
import { ChipArt } from '@/shared/ui/ChipArt';
import { ExternalIcon } from '@/shared/ui/action-icons';
import { CleanZone, KV } from '@/shared/ui/primitives';
import { chipLore, chipName, rarityColor, rarityName, RARITY_PROFILES, ELEMENT_OF_COLLECTION, collectionName, chipImageOf } from '@/shared/lib/rarity';
import { ElementGlyph } from '@/shared/ui/element-icons';
import { ListModal } from '@/features/market/ListModal';
import { useUiStore } from '@/app/store/ui';
import { EXPLORER } from '@/app/config';
import { isMock } from '@/api/client';
import { chipIndexText, timeAgo, fmtUsd } from '@/shared/lib/format';

export function ChipDrawer({ chip, onClose }: { chip: Chip; onClose: () => void }) {
  const t = useT();
  const nav = useNavigate();
  const { connection } = useConnection();
  const wallet = useWalletLike();
  const cfg = useGameConfig();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const [listing, setListing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const prof = RARITY_PROFILES[chip.rarity!];
  const locked = !!chip.lockUntil && new Date(chip.lockUntil).getTime() > Date.now();
  const lockExpired = !!(chip.flags?.soulbound || chip.lockUntil) && !locked;
  const free = !chip.flags?.staked && !chip.flags?.listed && !chip.flags?.fusing && !locked;

  async function run(kind: MessageKey, build: () => Promise<import('@solana/web3.js').TransactionInstruction[]>) {
    if (isMock()) { toast({ kind: 'info', title: { key: 'screens.mockMode' }, body: joinText([{ key: kind }, ": ", { key: 'screens.simulated' }]) }); onClose(); return; }
    if (!wallet || !cfg.data) return;
    setBusy(kind);
    try {
      const ixs = await build();
      const { signature } = await sendTx(connection, wallet, ixs);
      toast({ kind: 'success', title: { key: 'screens.transactionDone', params: { action: { key: kind } } }, href: EXPLORER.tx(signature) });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['staking'] });
      void qc.invalidateQueries({ queryKey: ['chain'] });
      onClose();
    } catch (e) {
      toast({ kind: 'error', title: { key: 'screens.transactionFailed', params: { action: { key: kind } } }, error: e });
    } finally {
      setBusy(null);
    }
  }

  /** Stake a registered V2 leaf: identity from chain, Merkle path from DAS, verified before signing. */
  const stake = async () => {
    const r = await resolveCompressedChip(connection, dasClient(), new PublicKey(chip.asset!), { owner: wallet!.publicKey });
    return [stakeCompressedChipV2Ix({
      owner: wallet!.publicKey, claim: r.claim, chip: r.chip, merkleTree: r.merkleTree, delegate: r.delegate, proof: r.leaf,
    })];
  };

  /**
   * Unstake a V2 leaf. Only the claim PDA is needed — `unstake_compressed_chip` reads no proof — so
   * this resolves the on-chain half and skips the DAS round trip entirely.
   */
  const unstake = async () => {
    const claim = (await resolveCompressedChipIdentity(connection, new PublicKey(chip.asset!))).claim;
    return [createAtaIdempotentIx(wallet!.publicKey, wallet!.publicKey, cfg.data!.cgMint), unstakeCompressedChipIx({ owner: wallet!.publicKey, claim, cgMint: cfg.data!.cgMint })];
  };

  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ width: 'min(198px, 100%)', flex: '0 0 auto' }}><ChipArt collection={chip.collection!} rarity={chip.rarity!} index={chip.index} level={chip.level} imageUrl={chipImageOf(chip, 512)} skin={chip.skin} crimp={rarityColor(chip.rarity!)} /></div>
        <div className="grow stack-sm">
          <div style={{ color: rarityColor(chip.rarity!) }} className="strong">{rarityName(chip.rarity!)} · {collectionName(chip.collection!)} <ElementGlyph element={ELEMENT_OF_COLLECTION[chip.collection!]} /></div>
          <div className="small muted">{chipIndexText(chip.index) ?? t('ui.unnumbered')} · {t('ui.level')} {chip.level}/{prof.maxLevel} · {t('ui.power')} {chip.power} · {t('ui.stakeWeight')} {chip.stakeWeight}</div>
          <div className="small" style={{ lineHeight: 1.45 }}>{chipLore(chip.collection!, chip.rarity!)}</div>
          <div className="tag-list">
            {chip.flags?.staked && <span className="pill">{t('collection.filters.staked')}</span>}
            {chip.flags?.listed && <span className="pill">{t('collection.filters.listed')}</span>}
            {chip.flags?.fusing && <span className="pill">{t('ui.inFusion')}</span>}
            {locked && <span className="pill pill-danger">{t('ui.lockedUntil')} {fmtLocale.dateTime(chip.lockUntil!)}</span>}
            {lockExpired && <span className="pill pill-ok">{t('ui.lockExpired')}</span>}
          </div>
        </div>
      </div>

      {chip.listing && (
        <CleanZone>
          <KV k={t('screens.listedAt')} v={`${fmtUsd(chip.listing.priceUsd)} (${chip.listing.currency ?? '—'})`} accent />
          <KV k={t('screens.since')} v={timeAgo(chip.listing.createdAt!)} />
        </CleanZone>
      )}

      <div className="grid-2">
        {free && <button className="btn" onClick={() => setListing(true)}>{t('ui.listMarket')}</button>}
        {free && <button className="btn" disabled={busy !== null} onClick={() => run('staking.stake', stake)}>{t('ui.stakeCg')}</button>}
        {free && chip.rarity! < 8 && <button className="btn" onClick={() => { onClose(); nav(`/fusion?add=${chip.asset}`); }}>{t('ui.sendBench')}</button>}
        {/* No separate claim: `unstake_compressed_chip` mints the pending reward as it closes the
            stake, so claiming early would mean unstaking. The pending figure is on the row above. */}
        {chip.flags?.staked && <button className="btn" disabled={busy !== null} onClick={() => run('staking.unstake', unstake)}>{t('staking.unstake')}</button>}
        {chip.flags?.listed && <Link className="btn" to={`/market/${chip.asset}`} onClick={onClose}>{t('ui.manageListing')}</Link>}
        {lockExpired && <button className="btn" disabled={busy !== null} onClick={() => run('ui.thaw', async () => { const r = await resolveCompressedChipIdentity(connection, new PublicKey(chip.asset!)); return [thawChipIx({ owner: wallet!.publicKey, asset: r.asset, collectionIdx: r.collectionIdx, coreCollection: r.coreCollection })]; })}>{t('ui.thaw')}</button>}
        <Link className="btn btn-ghost" to={`/market/${chip.asset}`} onClick={onClose}>{t('ui.provenanceLink')}</Link>
      </div>
      <div className="tiny muted">{chipName(chip.collection!, chip.rarity!)} · <a href={EXPLORER.account(chip.asset!)} target="_blank" rel="noreferrer" className="row" style={{ gap: 3, display: 'inline-flex' }}>{t('ui.asset')} {chip.asset!.slice(0, 6)}… <ExternalIcon size={10} /></a></div>

      {listing && <ListModal chip={chip} onClose={() => { setListing(false); onClose(); }} />}
    </div>
  );
}
