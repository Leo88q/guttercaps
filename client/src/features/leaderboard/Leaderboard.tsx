import { leagueName } from '@/shared/lib/rarity';
import { Link, useParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useLeaderboard, useSeason } from '@/api/hooks';
import { Pill, Skeleton, Empty } from '@/shared/ui/primitives';
import { shortKey, fmtCg, countdown } from '@/shared/lib/format';

import { useT, fmtLocale, type MessageKey } from '@/shared/i18n';
import LineBoardPanel from '@/features/bowl/LineBoardPanel';

const BOARDS = [
  { id: 'rating', label: 'leaderboard.boards.rating', unit: 'ELO' },
  // docs/16 §5.5: «линия недели» стоит рядом с рейтингом, а не в углу экрана линии.
  { id: 'line', label: 'line.title', unit: 'line.score' },
  { id: 'wins', label: 'ui.wagerWins', unit: 'ui.wins' },
  { id: 'collection', label: 'ui.collectors', unit: '/72' },
  { id: 'staking', label: 'ui.stakers', unit: 'staking.weight' },
  { id: 'fusion', label: 'ui.fusers', unit: 'ui.fusions' },
  { id: 'divers', label: 'leaderboard.boards.divers', unit: '★' },
] as const;
type Board = (typeof BOARDS)[number]['id'];

export default function Leaderboard() {
  const t = useT();
  const { board = 'rating' } = useParams();
  const b = (BOARDS.find((x) => x.id === board) ?? BOARDS[0]);
  // У линии своя доска и свой вход в реплей, общим запросом она не читается —
  // но хук надо вызвать в любом случае, поэтому просим рейтинг и не показываем его.
  const q = useLeaderboard(b.id === 'line' ? 'rating' : (b.id as Exclude<Board, 'line'>));
  const season = useSeason();
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();

  return (
    <div className="page page-bg page-bg-leaderboard stack">
      <div>
        <h1 className="page-title">{t('leaderboard.title')}</h1>
        <p className="page-sub">{t('leaderboard.subtitle', { id: season.data?.id ?? '—', time: season.data ? countdown(season.data.endsAt!) : '—', amount: season.data ? fmtCg(season.data.poolCgMicro, 0) : '—' })}</p>
      </div>
      <div className="tabs">{BOARDS.map((x) => <Link key={x.id} to={`/leaderboard/${x.id}`} style={{ textDecoration: 'none' }}><Pill active={x.id === b.id}>{t(x.label)}</Pill></Link>)}</div>

      {/* Доска линии — свои строки и свой вход в реплей, поэтому она не идёт через общую таблицу. */}
      {b.id === 'line' && <LineBoardPanel />}

      {b.id !== 'line' && q.data?.me && (
        <div className="card row between">
          <span>{t('ui.yourRank')}</span><span className="mono">#{(q.data.me as { rank?: number }).rank} · {(q.data.me as { value?: number }).value} {b.unit.includes('.') ? t(b.unit as MessageKey) : b.unit}</span>
        </div>
      )}

      {b.id !== 'line' && (q.isLoading ? <Skeleton h={400} /> : !q.data?.items?.length ? <Empty>{t('ui.noEntries')}</Empty> : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="table">
            <thead><tr><th>#</th><th>{t('leaderboard.player')}</th>{b.id === 'rating' && <th>{t('arena.league')}</th>}<th style={{ textAlign: 'right' }}>{b.unit.includes('.') ? t(b.unit as MessageKey) : b.unit}</th></tr></thead>
            <tbody>
              {q.data.items.map((r) => (
                <tr key={r.wallet} className={r.wallet === me ? 'me' : ''}>
                  <td className={`mono${r.rank && r.rank <= 3 ? ` rank-${r.rank}` : ''}`}>{r.rank}</td>
                  <td>{r.handle || shortKey(r.wallet)}{r.wallet === me && <span className="pill pill-ok" style={{ marginLeft: 6 }}>{t('ui.you')}</span>}</td>
                  {b.id === 'rating' && <td className="muted">{leagueName(r.league ?? 0)}</td>}
                  <td className="mono" style={{ textAlign: 'right' }}>{r.value !== undefined ? fmtLocale.int(r.value) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
