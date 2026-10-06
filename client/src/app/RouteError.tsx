// Route-level error screen (replaces react-router's default "Hey developer" page).
// The most common cause in production is a stale tab after a redeploy: the old
// index references hashed chunks that no longer exist, the SPA fallback serves
// index.html instead, and the browser rejects it ("'text/html' is not a valid
// JavaScript MIME type"). For that case we reload once automatically.
import { useEffect } from 'react';
import { useRouteError } from 'react-router-dom';
import { getLocale } from '@/shared/i18n';

const RELOAD_FLAG = 'gc:chunk-reload';

function isChunkLoadError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /MIME type|dynamically imported module|Importing a module script failed|Failed to fetch dynamically|error loading dynamically|ChunkLoadError|does not provide an export named/i.test(msg);
}

/** Reload the page once per session for a stale-chunk error; returns false if we already tried. */
export function reloadOnceForStaleChunk(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch { /* storage blocked — still try once */ }
  window.location.reload();
  return true;
}
/** Called after a successful boot so a later deploy can auto-reload again. */
export function clearChunkReloadFlag() { try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* ignore */ } }

const COPY: Record<string, { title: string; stale: string; generic: string; reload: string; home: string }> = {
  en: { title: 'The wall got repainted', stale: 'A new version of Gutter City just rolled out. Reload to catch up.', generic: 'Something slipped down the drain. Reload the page — your chips are safe on-chain.', reload: 'Reload', home: 'Home' },
  ru: { title: 'Стену перекрасили', stale: 'Вышла новая версия Gutter City. Обновите страницу, чтобы догнать город.', generic: 'Что-то утекло в водосток. Обновите страницу — ваши фишки в безопасности, они в блокчейне.', reload: 'Обновить', home: 'Главная' },
  es: { title: 'Repintaron el muro', stale: 'Salió una nueva versión de Gutter City. Recarga para ponerte al día.', generic: 'Algo se fue por la alcantarilla. Recarga la página: tus caps están seguros on-chain.', reload: 'Recargar', home: 'Inicio' },
  pt: { title: 'Pintaram o muro de novo', stale: 'Saiu uma nova versão de Gutter City. Recarregue para acompanhar.', generic: 'Algo escorreu pelo bueiro. Recarregue a página — seus caps estão seguros on-chain.', reload: 'Recarregar', home: 'Início' },
  vi: { title: 'Bức tường vừa được sơn lại', stale: 'Gutter City vừa có phiên bản mới. Tải lại trang để cập nhật.', generic: 'Có gì đó trôi xuống cống. Tải lại trang — nắp của bạn vẫn an toàn trên chuỗi.', reload: 'Tải lại', home: 'Trang chủ' },
  id: { title: 'Temboknya baru dicat ulang', stale: 'Versi baru Gutter City baru saja rilis. Muat ulang untuk mengikuti.', generic: 'Ada yang hanyut ke selokan. Muat ulang halaman — caps kamu aman on-chain.', reload: 'Muat ulang', home: 'Beranda' },
  fil: { title: 'Pinintahan ulit ang pader', stale: 'May bagong bersyon ang Gutter City. I-reload para makasabay.', generic: 'May nahulog sa kanal. I-reload ang page — ligtas ang caps mo on-chain.', reload: 'I-reload', home: 'Home' },
};

export function RouteError() {
  const error = useRouteError();
  const stale = isChunkLoadError(error);
  useEffect(() => { if (stale) reloadOnceForStaleChunk(); }, [stale]);
  let loc = 'en';
  try { loc = getLocale(); } catch { /* i18n not ready */ }
  const c = COPY[loc] ?? COPY.en;
  return (
    <div className="page stack" role="alert" style={{ maxWidth: 560, margin: '12vh auto', textAlign: 'center' }}>
      <h1 className="h1">{c.title}</h1>
      <p className="muted">{stale ? c.stale : c.generic}</p>
      {import.meta.env.DEV && error != null && (
        <pre className="mono tiny muted" style={{ maxWidth: '100%', overflowX: 'auto', textAlign: 'left', whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: 10, border: '1px solid var(--gc-line)', borderRadius: 8 }}>
          {error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)}
        </pre>
      )}
      <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
        <button className="btn" onClick={() => { clearChunkReloadFlag(); window.location.reload(); }}>{c.reload}</button>
        <a className="btn" href="/">{c.home}</a>
      </div>
    </div>
  );
}
