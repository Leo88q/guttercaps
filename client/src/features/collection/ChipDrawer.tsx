// Detail + actions for one owned chip: list on market, stake, send to bench, thaw.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { PublicKey } from '@solana/web3.js';
import type { Chip } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { sendTx } from '@/chain/tx';
import { fetchCoreCollections } from '@/chain/flows/packFlow';
import { thawChipIx } from '@/chain/ix/chipCore';
import { stakeChipIx, unstakeChipIx, claimChipIx } from '@/chain/ix/staking';
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
import { chipIndexText, timeAgo } from '@/shared/lib/format';

export function ChipDrawer({ chip, onClose }: { chip: Chip; onClose: () => void }) {
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

  async function run(kind: string, build: () => Promise<import('@solana/web3.js').TransactionInstruction[]>) {
    if (isMock()) { toast({ kind: 'info', title: 'Mock mode', body: `${kind}: transaction simulated` }); onClose(); return; }
    if (!wallet || !cfg.data) return;
    setBusy(kind);
    try {
      const ixs = await build();
      const { signature } = await sendTx(connection, wallet, ixs);
      toast({ kind: 'success', title: `${kind} confirmed`, href: EXPLORER.tx(signature) });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['staking'] });
      void qc.invalidateQueries({ queryKey: ['chain'] });
      onClose();
    } catch (e) {
      toast({ kind: 'error', title: `${kind} failed`, body: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(null);
    }
  }

  const ref = async () => {
    const cores = await fetchCoreCollections(connection, cfg.data!.collectionsCreated);
    return { asset: new PublicKey(chip.asset!), collectionIdx: chip.collection!, coreCollection: cores.get(chip.collection!)! };
  };

  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ width: 'min(198px, 100%)', flex: '0 0 auto' }}><ChipArt collection={chip.collection!} rarity={chip.rarity!} index={chip.index} level={chip.level} imageUrl={chipImageOf(chip, 512)} skin={chip.skin} crimp={rarityColor(chip.rarity!)} /></div>
        <div className="grow stack-sm">
          <div style={{ color: rarityColor(chip.rarity!) }} className="strong">{rarityName(chip.rarity!)} · {collectionName(chip.collection!)} <ElementGlyph element={ELEMENT_OF_COLLECTION[chip.collection!]} /></div>
          <div className="small muted">{chipIndexText(chip.index) ?? 'unnumbered'} · level {chip.level}/{prof.maxLevel} · power {chip.power} · stake weight {chip.stakeWeight}</div>
          <div className="small" style={{ lineHeight: 1.45 }}>{chipLore(chip.collection!, chip.rarity!)}</div>
          <div className="tag-list">
            {chip.flags?.staked && <span className="pill">staked</span>}
            {chip.flags?.listed && <span className="pill">listed</span>}
            {chip.flags?.fusing && <span className="pill">in fusion</span>}
            {locked && <span className="pill pill-danger">locked until {new Date(chip.lockUntil!).toLocaleString()}</span>}
            {lockExpired && <span className="pill pill-ok">lock expired — thaw to trade</span>}
          </div>
        </div>
      </div>

      {chip.listing && (
        <CleanZone>
          <KV k="Listed at" v={`${chip.listing.priceUsd ? `$${chip.listing.priceUsd.toFixed(2)}` : ''} (${chip.listing.currency})`} accent />
          <KV k="Since" v={timeAgo(chip.listing.createdAt!)} />
        </CleanZone>
      )}

      <div className="grid-2">
        {free && <button className="btn" onClick={() => setListing(true)}>List on market</button>}
        {free && <button className="btn" disabled={busy !== null} onClick={() => run('Stake', async () => { const r = await ref(); return [stakeChipIx({ ...r, owner: wallet!.publicKey })]; })}>Stake for $CG</button>}
        {free && chip.rarity! < 8 && <button className="btn" onClick={() => { onClose(); nav(`/fusion?add=${chip.asset}`); }}>Send to fusion bench</button>}
        {chip.flags?.staked && <button className="btn" disabled={busy !== null} onClick={() => run('Claim', async () => [createAtaIdempotentIx(wallet!.publicKey, wallet!.publicKey, cfg.data!.cgMint), claimChipIx({ owner: wallet!.publicKey, asset: new PublicKey(chip.asset!), cgMint: cfg.data!.cgMint })])}>Claim rewards</button>}
        {chip.flags?.staked && <button className="btn" disabled={busy !== null} onClick={() => run('Unstake', async () => { const r = await ref(); return [createAtaIdempotentIx(wallet!.publicKey, wallet!.publicKey, cfg.data!.cgMint), unstakeChipIx({ ...r, owner: wallet!.publicKey, cgMint: cfg.data!.cgMint })]; })}>Unstake</button>}
        {chip.flags?.listed && <Link className="btn" to={`/market/${chip.asset}`} onClick={onClose}>Manage listing</Link>}
        {lockExpired && <button className="btn" disabled={busy !== null} onClick={() => run('Thaw', async () => { const r = await ref(); return [thawChipIx({ ...r, owner: wallet!.publicKey })]; })}>Thaw (unlock)</button>}
        <Link className="btn btn-ghost" to={`/market/${chip.asset}`} onClick={onClose}>Full page & provenance</Link>
      </div>
      <div className="tiny muted">{chipName(chip.collection!, chip.rarity!)} · <a href={EXPLORER.account(chip.asset!)} target="_blank" rel="noreferrer" className="row" style={{ gap: 3, display: 'inline-flex' }}>asset {chip.asset!.slice(0, 6)}… <ExternalIcon size={10} /></a></div>

      {listing && <ListModal chip={chip} onClose={() => { setListing(false); onClose(); }} />}
    </div>
  );
}
