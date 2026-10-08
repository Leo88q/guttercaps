import { TxError } from '@/chain/tx';
import { skinText, emotePackName } from '@/shared/lib/cosmetics';
// "Extras" tab — the voluntary-spend catalogue (cosmetics, identity,
// convenience, boosters). Every card states what the money does (burn vs
// treasury) and that nothing here buys power; the money UI lives in a clean zone.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useQueryClient } from '@tanstack/react-query';
import { EMOTE_PACKS, SERVICES, SKINS, type ServiceDef } from '@guttercaps/economy';
import { claimWithRetry, api, isMock } from '@/api/client';
import { useFloor, useGrid, useMyChips, useMyServices, useServices } from '@/api/hooks';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { usePaymentRails } from '@/chain/rails';
import { Currency, type CurrencyCode } from '@/chain/ix/chipCore';
import { payForService, quoteService, serviceRefHash } from '@/chain/flows/serviceFlow';
import { useUiStore } from '@/app/store/ui';
import { EXPLORER } from '@/app/config';
import { fmtAmount, fmtCents, fmtUsd, CURRENCY_SYMBOLS } from '@/shared/lib/format';
import { CleanZone, KV, Modal, Pill } from '@/shared/ui/primitives';
import { CapPicker } from '@/shared/ui/CapPicker';
import { PROFILE_THEMES } from '@/shared/lib/cosmetics';
import { useCollections } from '@/shared/lib/lore';
import { CleanConfirmButton, SprayNozzleButton } from '@/shared/ui/buttons';
import { useT, useLocale, fmtLocale } from '@/shared/i18n';
import { ServiceGlyph } from '@/shared/ui/service-icons';

export function Services() {
  const t = useT();
  const { locale } = useLocale();
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const catalogue = useServices();
  const mine = useMyServices();
  const [sel, setSel] = useState<ServiceDef | null>(null);

  const owned = useMemo(() => new Set((mine.data?.entitlements ?? []).map((e) => e.kind)), [mine.data]);
  const dailyLeft = mine.data?.dailyLeft ?? {};

  return (
    <div className="stack">
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <div>
          <div className="strong">{t('services.title')}</div>
          <div className="small muted">{t('ui.extrasSubtitle')}</div>
        </div>
        <Pill>{t('services.noPower')}</Pill>
      </div>

      <div className="grid-3">
        {SERVICES.filter((s) => s.id !== 'handleChange' && s.dailyCap > 0).map((s) => {
          const isOwned = owned.has(s.kind) && !s.recurring && s.fulfilment === 'entitlement' && s.id !== 'capSkin';
          const left = dailyLeft[String(s.kind)];
          const passActive = s.id === 'seasonPass' && (mine.data?.entitlements ?? []).some((e) => e.kind === 6 && e.expiresAt && new Date(e.expiresAt).getTime() > Date.now());
          return (
            <div key={s.id} className="card stack-sm" style={{ position: 'relative' }}>
              <div className="row between">
                <span style={{ color: 'var(--cg-chrome)', display: 'inline-flex' }} aria-hidden><ServiceGlyph id={s.id} size={24} /></span>
                <span className="mono strong">{fmtCents(s.priceUsdCents)}</span>
              </div>
              <div className="strong">{t(`services.names.${s.id}`)}</div>
              <div className="tiny muted" style={{ minHeight: 44 }}>{t(`services.blurbs.${s.id}`)}</div>
              <div className="tag-list">
                {s.id === 'booster' && <Pill>{t('services.boosterCap')}</Pill>}
                {left !== undefined && <Pill>{t('services.dailyLeft', { n: left })}</Pill>}
                {passActive && <Pill active>{t('services.active')}</Pill>}
              </div>
              {s.id === 'handle' ? (
                <Link to="/profile" className="btn" style={{ textAlign: 'center' }}>{t('profile.handle.get')}</Link>
              ) : (
                <SprayNozzleButton disabled={isOwned || passActive || left === 0} onClick={() => (connected ? setSel(s) : setVisible(true))}>
                  {isOwned ? t('services.owned') : passActive ? t('services.active') : t('services.buy')}
                </SprayNozzleButton>
              )}
            </div>
          );
        })}
      </div>

      <div className="tiny muted">{t('services.howItWorks')}</div>
      {catalogue.data?.skrUsd !== undefined && <div className="tiny muted mono">1 SKR ≈ {fmtUsd(catalogue.data.skrUsd, 4)} · 1 SOL ≈ {fmtUsd(catalogue.data.solUsd)} · {fmtLocale.dateTime(Date.now(), locale)}</div>}
      {sel && <ServiceModal service={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function ServiceModal({ service, onClose }: { service: ServiceDef; onClose: () => void }) {
  const COLLECTIONS = useCollections();
  const t = useT();
  const { connection } = useConnection();
  const wallet = useWalletLike();
  const cfg = useGameConfig();
  const floor = useFloor();
  const qc = useQueryClient();
  const toast = useUiStore((s) => s.toast);
  const [currency, setCurrency] = useState<CurrencyCode>(Currency.CG);
  const [busy, setBusy] = useState(false);
  // purchase-time variants: the payload is hashed into ref_hash, so the variant is chosen BEFORE paying
  const [asset, setAsset] = useState<string | null>(null);
  const [skin, setSkin] = useState<string>(SKINS[0].id);
  const [theme, setTheme] = useState<string>(PROFILE_THEMES[0].id);
  const [pack, setPack] = useState<string>(EMOTE_PACKS[0].id);
  const [collection, setCollection] = useState<number | null>(null);
  const chips = useMyChips({});
  const grid = useGrid();
  const caps = useMemo(() => chips.data?.pages.flatMap((pg) => pg.items ?? []) ?? [], [chips.data]);
  const completed = useMemo(() => (grid.data?.cells ?? []).map((row, ci) => (row.length === 9 && row.every((n) => n > 0) ? ci : -1)).filter((ci) => ci >= 0), [grid.data]);
  const payload = useMemo(() => {
    switch (service.id) {
      case 'capSkin': return asset ? { asset, skin } : null;
      case 'profileTheme': return { theme };
      case 'arenaEmotePack': return { pack };
      case 'districtBanner': return collection !== null ? { collection } : null;
      default: return { id: service.id, v: 1 };
    }
  }, [service.id, asset, skin, theme, pack, collection]);

  // Same gate as the pack shop — one implementation, so the two catalogues cannot disagree about
  // which rails exist. Cosmetics are the case this bit hardest: the rail vanished and a player with
  // SKR in their wallet saw only CG/SOL/USDC with no hint that SKR was ever an option here.
  const { skr: skrEnabled, skrWhy } = usePaymentRails();
  const currencies: CurrencyCode[] = [Currency.CG, Currency.SOL, Currency.USDC, ...(skrEnabled ? [Currency.SKR] : [])];
  const quote = useMemo(() => {
    try { return quoteService(service.id, currency, { solUsd: floor.data?.solUsd, skrUsd: floor.data?.skrUsd }); } catch { return null; }
  }, [service.id, currency, floor.data?.solUsd, floor.data?.skrUsd]);

  async function submit() {
    if (!quote || !payload) return;
    if (isMock()) {
      await api.post('/services/claim', { signature: `mock-${Date.now()}`, kind: service.kind, payload });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast({ kind: 'money', title: { key: 'services.bought' }, body: { key: `services.names.${service.id}` } });
      onClose();
      return;
    }
    if (!wallet || !cfg.data) return;
    setBusy(true);
    try {
      const refHash = serviceRefHash(service.kind, wallet.publicKey, payload);
      const { signature } = await payForService({ connection, wallet, id: service.id, currency, refHash, quote, cfg: cfg.data });
      // entitlements are granted only on a finalized payment (SEC-M5) — retry through indexer lag + finality (≈ 1–2 min)
      if (service.fulfilment === 'entitlement') await claimWithRetry(() => api.post('/services/claim', { signature, kind: service.kind, payload }));
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast({ kind: 'money', title: { key: 'services.bought' }, body: { key: `services.names.${service.id}` }, href: EXPLORER.tx(signature) });
      onClose();
    } catch (e) {
      toast({ kind: 'error', title: { key: 'services.buyFailed' }, error: e, href: e instanceof TxError && e.signature ? EXPLORER.tx(e.signature) : undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t(`services.names.${service.id}`)}>
      <div className="stack">
        <div className="small muted">{t(`services.blurbs.${service.id}`)}</div>
        <div className="stack-sm">
          <span className="label">{t('shop.payWith')}</span>
          <div className="tag-list">
            {currencies.map((c) => (
              <Pill key={c} active={currency === c} onClick={() => setCurrency(c)}>{CURRENCY_SYMBOLS[c]} · {c === Currency.CG ? t('services.burned') : t('services.toTreasury')}</Pill>
            ))}
            {/* Named, not omitted — see the note in Shop.tsx. */}
            {!skrEnabled && <Pill tone="danger">{`SKR · ${t(skrWhy!)}`}</Pill>}
          </div>
        </div>
        {service.id === 'capSkin' && (
          <>
            <div className="stack-sm">
              <span className="label">{t('services.pickSkin')}</span>
              <div className="tag-list">{SKINS.map((s) => <Pill key={s.id} active={skin === s.id} onClick={() => setSkin(s.id)}>{skinText(s.id)}</Pill>)}</div>
              <div className="tiny muted">{skinText(skin, true)}</div>
            </div>
            <div className="stack-sm">
              <span className="label">{t('services.pickCap')}</span>
              <CapPicker caps={caps} selected={asset} onSelect={setAsset} emptyHint={t('services.noFreeCaps')} previewSkin={skin} />
            </div>
          </>
        )}
        {service.id === 'profileTheme' && (
          <div className="stack-sm">
            <span className="label">{t('services.pickTheme')}</span>
            <div className="tag-list">
              {PROFILE_THEMES.map((th) => <Pill key={th.id} active={theme === th.id} onClick={() => setTheme(th.id)}><span style={{ width: 8, height: 8, borderRadius: 4, background: th.hex }} />{th.label}</Pill>)}
            </div>
            <div className="tiny muted">{PROFILE_THEMES.find((x) => x.id === theme)?.desc}</div>
          </div>
        )}
        {service.id === 'arenaEmotePack' && (
          <div className="stack-sm">
            <span className="label">{t('services.pickPack')}</span>
            <div className="tag-list">{EMOTE_PACKS.map((x) => <Pill key={x.id} active={pack === x.id} onClick={() => setPack(x.id)}>{emotePackName(x.id)}</Pill>)}</div>
            <div className="tag-list">{EMOTE_PACKS.find((x) => x.id === pack)?.emotes.map((e) => <span key={e.id} className="spray-tag" style={{ color: e.color }}>{e.tag}</span>)}</div>
          </div>
        )}
        {service.id === 'districtBanner' && (
          <div className="stack-sm">
            <span className="label">{t('services.pickDistrict')}</span>
            {completed.length === 0 ? <div className="tiny muted">{t('services.noCompletedDistrict')}</div> : (
              <div className="tag-list">
                {completed.map((ci) => <Pill key={ci} active={collection === ci} onClick={() => setCollection(ci)}>{COLLECTIONS[ci].name}</Pill>)}
              </div>
            )}
          </div>
        )}
        <CleanZone>
          <KV k={t(`services.names.${service.id}`)} v={fmtCents(service.priceUsdCents)} />
          {quote ? <KV total accent k={t('common.youSign')} v={fmtAmount(quote.amount, currency)} /> : <div className="tiny muted">{t('services.noQuote')}</div>}
          {(currency === Currency.SOL || currency === Currency.SKR) && quote && <KV k={t('shop.maxSlippage')} v={fmtAmount(quote.maxUnits, currency)} />}
        </CleanZone>
        <div className="tiny muted">{t('services.howItWorks')}</div>
        <CleanConfirmButton disabled={!quote || !payload || busy} onClick={submit}>{busy ? t('common.signing') : t('common.confirmSign')}</CleanConfirmButton>
      </div>
    </Modal>
  );
}
