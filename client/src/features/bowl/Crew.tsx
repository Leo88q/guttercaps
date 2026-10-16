// docs/16 §5.6 — Команды.
//
// Три вещи, которые здесь нельзя испортить.
//
// 1. **Хартия покупает имя, а не стену.** $1.99 — это имя, состав и командная
//    доска. Сегмент стены команда получает, но держит его по тем же правилам
//    активности, что обычный слот (§3.4, решение 6 из §0.3): платного пути на
//    стену не существует, и экран об этом говорит прямо.
// 2. **Доска считает пятерых лучших, а не весь состав.** Состав показывает,
//    кто в пятёрке, а кто вне её — иначе игрок не поймёт, почему десятый
//    райдер ничего не дал команде.
// 3. **Имя модерируется как тег.** Жалоба уходит в ту же очередь с тем же SLA
//    24 часа, поэтому на карточке чужой команды есть «пожаловаться», а у себя
//    — код приглашения.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { CREW, CREW_NAME_RE, SERVICE_BY_ID } from '@guttercaps/economy';
import { claimWithRetry, isMock } from '@/api/client';
import {
  useCharterCrew, useCrew, useCrewBoard, useCrewCheck, useJoinCrew, useLeaveCrew, useMyCrew, useRenameCrew, useReportCrew,
  type CrewView,
} from '@/api/hooksLazy';
import { useGameConfig, useWalletLike } from '@/chain/hooks';
import { payForService, quoteService, serviceRefHash } from '@/chain/flows/serviceFlow';
import { Currency, type CurrencyCode } from '@/chain/ix/chipCore';
import { useT } from '@/shared/i18n';
import { useUiStore } from '@/app/store/ui';
import { CURRENCY_SYMBOLS, fmtAmount, fmtCents, shortKey } from '@/shared/lib/format';
import { collectionName } from '@/shared/lib/rarity';
import { CleanZone, KV, Modal, Pill, Skeleton } from '@/shared/ui/primitives';
import { CleanConfirmButton } from '@/shared/ui/buttons';
import { ErrorNotice } from '@/shared/ui/ErrorNotice';
import './crew.css';

const tierKey = (tier: string) => `line.tiers.${tier}` as 'line.tiers.none';
/** Район сегмента: восемь районов города, как в стене и каталоге. */
const DISTRICTS = Array.from({ length: 8 }, (_, i) => i);

// ------------------------------------------------------------------ карточка

function CrewCard({ crew, onRename, onLeave, onReport, reporting }: {
  crew: CrewView;
  onRename?: () => void;
  onLeave?: () => void;
  onReport?: () => void;
  reporting?: boolean;
}) {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const copy = () => {
    void navigator.clipboard?.writeText(crew.inviteCode ?? '');
    toast({ kind: 'success', title: { key: 'common.copied' } });
  };
  const filled = crew.members ?? [];
  return (
    <div className="card stack-sm">
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <div className="strong">{crew.name}</div>
        <span className="mono tiny muted">
          {t('crew.segmentSlots', { from: crew.slots?.from ?? 0, to: (crew.slots?.to ?? CREW.wallSegmentSlots) - 1, d: crew.district ?? 0 })}
        </span>
      </div>
      <div className="tiny muted">{collectionName(crew.district ?? 0)} · {t('crew.segment')} #{crew.segment ?? 0}</div>

      <div className="crew-scores">
        <div>
          <span className="tiny muted">{t('crew.week')}</span>
          <div className="mono strong">{crew.score ?? 0}</div>
        </div>
        <div>
          <span className="tiny muted">{t('crew.members')}</span>
          <div className="mono strong">{crew.memberCount ?? 0}/{crew.maxMembers ?? CREW.maxMembers}</div>
        </div>
        <div>
          <span className="tiny muted">{t('line.tier')}</span>
          <div className="strong">{t(tierKey(crew.tier ?? 'none'))}</div>
        </div>
      </div>
      <div className="tiny muted">{t('crew.weekNote')}</div>
      {!crew.counts && <div className="tiny muted">{t('crew.notRanked')}</div>}

      <div className="crew-roster">
        {filled.map((m) => (
          <div key={m.wallet} className={`crew-row${m.counting ? ' counting' : ''}`}>
            <span className="mono crew-wallet">
              {(m.handle ?? shortKey(m.wallet))}
              {m.wallet === crew.captain ? ` · ${t('crew.captain')}` : ''}
            </span>
            <span className="mono muted">{m.bestWeek ?? 0}</span>
            <span className="tiny muted">{m.counting ? t('crew.counting') : t('crew.outside')}</span>
          </div>
        ))}
      </div>

      {crew.inviteCode && (
        <div className="row" style={{ gap: 8 }}>
          <span className="tiny muted">{t('crew.code')}</span>
          <code className="mono crew-code">{crew.inviteCode}</code>
          <button className="btn btn-sm" onClick={copy}>{t('common.copy')}</button>
        </div>
      )}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {onRename && crew.iAmCaptain && <button className="btn btn-sm" onClick={onRename}>{t('crew.rename')}</button>}
        {onLeave && <button className="btn btn-sm btn-ghost" onClick={onLeave}>{t('crew.leave')}</button>}
        {onReport && <button className="btn btn-sm btn-ghost" onClick={onReport} disabled={reporting}>{t('crew.report')}</button>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ хартия

/**
 * Хартия: проверка имени → платёж ончейн → POST /v1/crew/charter.
 *
 * Платёж привязан к имени хешем в транзакции, поэтому «заплатить за одно имя и
 * забрать другое» невозможно: бэкенд сравнивает ref_hash до списания. Валюта
 * любая, но $CG сжигается — так же, как у хендла.
 */
function CharterDialog({ onClose, renaming }: { onClose: () => void; renaming?: boolean }) {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const { connection } = useConnection();
  const wallet = useWalletLike();
  const cfg = useGameConfig();
  const charter = useCharterCrew();
  const rename = useRenameCrew();
  const [input, setName] = useState('');
  const [district, setDistrict] = useState(0);
  const [currency, setCurrency] = useState<CurrencyCode>(Currency.CG);
  const [busy, setBusy] = useState<'idle' | 'signing' | 'claiming'>('idle');

  const service = SERVICE_BY_ID[renaming ? 'crewRename' : 'crewCharter'];
  const check = useCrewCheck(input.trim());
  const valid = CREW_NAME_RE.test(input.trim());
  const checking = valid && check.isFetching;
  const available = valid && !checking && !check.error && check.data?.available === true;
  const currencies: CurrencyCode[] = [Currency.CG, Currency.SOL, Currency.USDC];

  const quote = useMemo(() => {
    try { return quoteService(service.id, currency); } catch { return null; }
  }, [service.id, currency]);

  async function submit() {
    const name = input.trim();
    if (!available || !quote || busy !== 'idle') return;
    if (!isMock() && (!wallet || !cfg.data)) return;
    try {
      setBusy(isMock() ? 'claiming' : 'signing');
      // Реф-хеш считается от канонического payload: сервер требует ровно его.
      const payload = renaming ? { id: 'crewRename', name } : { id: 'crewCharter', name };
      let signature = `mock-${Date.now()}`;
      if (!isMock()) {
        if (!wallet || !cfg.data) return;
        const refHash = serviceRefHash(service.kind, wallet.publicKey, payload);
        ({ signature } = await payForService({ connection, wallet, id: service.id, currency, refHash, quote, cfg: cfg.data }));
        setBusy('claiming');
      }
      if (renaming) await claimWithRetry(() => rename.mutateAsync({ name, signature }));
      else await claimWithRetry(() => charter.mutateAsync({ name, district, signature }));
      toast({ kind: 'money', title: { key: renaming ? 'crew.renamed' : 'crew.saved' } });
      onClose();
    } catch {
      toast({ kind: 'error', title: { key: 'crew.failed' } });
    } finally {
      setBusy('idle');
    }
  }

  return (
    <Modal open onClose={onClose} title={renaming ? t('crew.rename') : t('crew.charter')}>
      <div className="stack">
        <div className="stack-sm">
          <span className="label">{t('crew.nameLabel')}</span>
          <input
            className="input mono"
            maxLength={CREW.nameMax}
            placeholder="slab_sisters"
            value={input}
            onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
          />
          <div className="tiny muted">{t('crew.rules')}</div>
          {checking && <div className="tiny muted">{t('common.checking')}</div>}
          {valid && !checking && !check.error && check.data && !check.data.available && (
            <div className="danger tiny">{t(`crew.reason.${check.data.reason ?? 'taken'}` as 'crew.reason.taken')}</div>
          )}
          {available && <div className="tiny" style={{ color: 'var(--acid)' }}>{t('crew.available')}</div>}
        </div>

        {!renaming && (
          <div className="stack-sm">
            <span className="label">{t('crew.districtLabel')}</span>
            <div className="tag-list">
              {DISTRICTS.map((d) => <Pill key={d} active={district === d} onClick={() => setDistrict(d)}>{collectionName(d)}</Pill>)}
            </div>
          </div>
        )}

        <div className="stack-sm">
          <span className="label">{t('shop.payWith')}</span>
          <div className="tag-list">
            {currencies.map((c) => (
              <Pill key={c} active={currency === c} onClick={() => setCurrency(c)}>{CURRENCY_SYMBOLS[c]}{c === Currency.CG ? ` · ${t('services.burned')}` : ''}</Pill>
            ))}
          </div>
        </div>

        <CleanZone>
          <KV k={t(`services.names.${service.id}` as 'services.names.crewCharter')} v={fmtCents(service.priceUsdCents)} />
          {quote && <KV total accent k={t('common.youSign')} v={fmtAmount(quote.amount, currency)} />}
        </CleanZone>
        <div className="tiny muted">{t('services.howItWorks')}</div>

        <CleanConfirmButton disabled={!available || !quote || busy !== 'idle'} onClick={submit}>
          {busy === 'signing' ? t('common.signing') : busy === 'claiming' ? t('common.working') : t('crew.cta', { price: fmtCents(service.priceUsdCents) })}
        </CleanConfirmButton>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ экран

export default function Crew() {
  const t = useT();
  const toast = useUiStore((s) => s.toast);
  const { name } = useParams();
  const mine = useMyCrew();
  const other = useCrew(name);
  const board = useCrewBoard();
  const join = useJoinCrew();
  const leave = useLeaveCrew();
  const report = useReportCrew();

  const [dialog, setDialog] = useState<null | 'charter' | 'rename' | 'report'>(null);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');

  // Чужая карточка приходит своим запросом: у неё другой код приглашения и
  // другой состав прав, а кэш «моей» команды подменять нельзя.
  const viewing = name ? other : mine;
  const crew = viewing.data ?? null;

  const submitJoin = async () => {
    try {
      await join.mutateAsync({ code: code.trim() });
      toast({ kind: 'success', title: { key: 'crew.joinCta' } });
      setCode('');
    } catch {
      toast({ kind: 'error', title: { key: 'crew.joinFailed' } });
    }
  };
  const submitLeave = async () => {
    try {
      // Капитан, уходящий из живой команды, передаёт роль: игрок должен знать,
      // что команда осталась с капитаном, а не обезглавленной.
      const out = await leave.mutateAsync();
      toast({ kind: 'info', title: { key: out?.captain ? 'crew.handover' : 'crew.left' } });
    } catch {
      toast({ kind: 'error', title: { key: 'crew.failed' } });
    }
  };
  const submitReport = async () => {
    if (!name || !reason.trim()) return;
    try {
      await report.mutateAsync({ name, reason: reason.trim() });
      toast({ kind: 'success', title: { key: 'crew.reportDone' } });
      setDialog(null);
      setReason('');
    } catch {
      toast({ kind: 'error', title: { key: 'crew.failed' } });
    }
  };

  return (
    <div className="stack">
      <div className="row between" style={{ alignItems: 'baseline' }}>
        <div>
          <div className="strong">{t(name ? 'crew.title' : 'crew.myCrew')}</div>
          <div className="small muted">{t('crew.intro')}</div>
        </div>
        {name && <Link className="btn btn-sm btn-ghost" to="/bowl/crew">{t('crew.myCrew')}</Link>}
      </div>

      {!name && viewing.isLoading && <Skeleton h={180} />}
      {!!viewing.error && !name && <div className="warn"><ErrorNotice error={viewing.error} /></div>}

      {crew && (
        <CrewCard
          crew={crew}
          onRename={crew.mine ? () => setDialog('rename') : undefined}
          onLeave={crew.mine ? () => void submitLeave() : undefined}
          onReport={crew.mine ? undefined : () => setDialog('report')}
          reporting={report.isPending}
        />
      )}

      {/* Своей команды нет — предлагаем собрать или вступить. Сегмент стены
          здесь не продаётся: хартия покупает имя, состав и доску (§5.6). */}
      {!name && mine.data === null && (
        <div className="card stack-sm">
          <div className="strong">{t('crew.alone')}</div>
          <div className="small muted">{t('crew.aloneBody', { price: fmtCents(SERVICE_BY_ID.crewCharter.priceUsdCents) })}</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm" onClick={() => setDialog('charter')}>{t('crew.charter')}</button>
          </div>
          <div className="crew-join">
            <input
              className="input mono"
              maxLength={8}
              placeholder="ABCD1234"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase())}
              aria-label={t('crew.code')}
            />
            <button className="btn btn-sm" onClick={() => void submitJoin()} disabled={code.length < 4 || join.isPending}>{t('crew.joinCta')}</button>
          </div>
          <div className="tiny muted">{t('crew.join')}</div>
        </div>
      )}

      {!name && (
        <div className="card stack-sm">
          <div className="strong">{t('crew.board')}</div>
          <div className="tiny muted">{t('crew.boardNote')}</div>
          {board.isLoading && <Skeleton h={120} />}
          {!board.isLoading && (board.data?.rows?.length ?? 0) === 0 && <div className="tiny muted">{t('crew.boardEmpty')}</div>}
          {(board.data?.rows?.length ?? 0) > 0 && (
            <div className="crew-board">
              <div className="crew-board-head">
                <span className="muted">#</span>
                <span className="muted">{t('crew.crewCol')}</span>
                <span className="muted">{t('crew.members')}</span>
                <span className="muted">{t('crew.score')}</span>
              </div>
              {(board.data?.rows ?? []).slice(0, 20).map((r) => (
                <Link key={r.id} to={`/bowl/crew/${r.name}`} className="crew-board-row">
                  <span className="mono muted">{r.rank ?? 0}</span>
                  <span>{r.name}</span>
                  <span className="mono muted">{r.members ?? 0}</span>
                  <span className="mono cg-accent">{r.score ?? 0}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {dialog === 'charter' && <CharterDialog onClose={() => setDialog(null)} />}
      {dialog === 'rename' && <CharterDialog onClose={() => setDialog(null)} renaming />}
      {dialog === 'report' && (
        <Modal open onClose={() => setDialog(null)} title={t('crew.reportTitle')}>
          <div className="stack">
            <textarea
              className="input"
              rows={3}
              maxLength={280}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('crew.reportTitle')}
              aria-label={t('crew.reportTitle')}
            />
            <CleanConfirmButton disabled={!reason.trim() || report.isPending} onClick={() => void submitReport()}>
              {t('crew.reportCta')}
            </CleanConfirmButton>
          </div>
        </Modal>
      )}
    </div>
  );
}
