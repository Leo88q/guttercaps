// docs/16 §5.5 — «Линия недели»: доска топ-50 и просмотр реплея.
//
// Одна и та же доска стоит и на экране линии, и рядом с ELO-доской: две доски
// разошлись бы, и «линия недели» перестала бы быть одной на весь город.
import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useLineBoard } from '@/api/hooks';
import { useT } from '@/shared/i18n';
import { Empty } from '@/shared/ui/primitives';
import LineReplay from './LineReplay';
import './line.css';

export default function LineBoardPanel({ week }: { week?: number }) {
  const t = useT();
  const board = useLineBoard(week);
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const [watch, setWatch] = useState<{ runId: number; who: string } | null>(null);

  return (
    <div className="stack-sm">
      {watch && (
        <LineReplay runId={watch.runId} who={watch.who} onClose={() => setWatch(null)} />
      )}
      {board.data?.rows.length ? (
        <ol className="line-board" data-testid="line-board">
          {board.data.rows.map((r) => {
            const who = r.handle ?? `${r.wallet.slice(0, 4)}…${r.wallet.slice(-4)}`;
            return (
              <li key={r.wallet} className={r.wallet === me ? 'is-me' : undefined}>
                <span className="line-rank">{t('line.rank', { n: r.rank })}</span>
                <span className="line-who">{who}{r.wallet === me && <span className="pill pill-ok">{t('line.you')}</span>}</span>
                <b>{r.score}</b>
                <span className="tiny muted">{t('line.tricks', { n: r.tricks })}</span>
                {/* Смотреть можно только то, что ещё живо: ввод стирается через 14 дней,
                    и доска не предлагает мёртвую ссылку. */}
                {r.hasReplay ? (
                  <button
                    type="button" className="btn btn-sm btn-ghost" data-testid="line-watch"
                    onClick={() => setWatch({ runId: r.runId, who })}
                  >
                    {t('line.watch')}
                  </button>
                ) : <span />}
              </li>
            );
          })}
        </ol>
      ) : <Empty>{t('line.boardEmpty')}</Empty>}
    </div>
  );
}
