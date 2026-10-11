import { useT } from '@/shared/i18n';
import { humanizeTxError } from '@/chain/errors';
import { originalErrorText } from '@/chain/errorSnapshot';

/** A localized summary plus intact, selectable technical evidence. React escapes all server text. */
export function ErrorNotice({ error }: { error: unknown }) {
  const t = useT();
  const summary = humanizeTxError(error);
  const original = originalErrorText(error);
  return (
    <div className="error-notice" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>{summary}</div>
      {original && original !== summary && <details open style={{ marginTop: 6 }} onClick={e => e.stopPropagation()}>
        <summary style={{ cursor: 'pointer', whiteSpace: 'normal' }}>{t('failures.details')}</summary>
        <pre className="tiny" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '50vh', overflow: 'auto', margin: '8px 0 0', userSelect: 'text' }}>{original}</pre>
      </details>}
    </div>
  );
}
