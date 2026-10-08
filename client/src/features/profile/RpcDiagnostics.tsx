import { useEffect, useRef, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { CLUSTER } from '@/app/config';
import { isMock } from '@/api/client';
import { diagnoseRpc } from '@/chain/rpcDiagnostics';
import { useT } from '@/shared/i18n';

/** Deliberately separate from sendTx and the wallet-signing status UI. */
export function RpcDiagnostics() {
  const { connection } = useConnection();
  const endpoint = connection.rpcEndpoint;
  const t = useT();
  const running = useRef<AbortController>();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState('');
  useEffect(() => {
    running.current?.abort(); running.current = undefined;
    setBusy(false); setReport('');
    return () => { running.current?.abort(); running.current = undefined; };
  }, [endpoint]);
  async function check() {
    if (running.current || isMock()) return;
    const controller = new AbortController(); running.current = controller;
    setBusy(true); setReport('');
    try {
      const result = await diagnoseRpc(endpoint, { signal: controller.signal, cluster: CLUSTER });
      if (!controller.signal.aborted && running.current === controller) setReport(JSON.stringify(result, null, 2));
    } catch {
      // Provider prose/URLs can contain credentials. Never echo unexpected errors.
      if (!controller.signal.aborted && running.current === controller) setReport('{"error":"diagnostic_failed"}');
    } finally {
      if (running.current === controller) { running.current = undefined; setBusy(false); }
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([report], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'guttercaps-rpc-check.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="stack-sm">
    <div className="tiny muted">{t('profile.rpcCheckHint')}</div>
    <div className="row">
      <button className="btn btn-sm" disabled={busy || isMock()} onClick={() => void check()}>{t('profile.rpcCheck')}</button>
      {busy && <button className="btn btn-sm" onClick={() => running.current?.abort()}>{t('common.cancel')}</button>}
    </div>
    {busy && <div role="status" className="tiny">{t('profile.rpcChecking')}</div>}
    {report && <>
      <textarea className="input mono tiny" aria-label={t('profile.rpcReport')} readOnly rows={10} value={report} />
      <button className="btn btn-sm" onClick={download}>{t('profile.rpcDownload')}</button>
    </>}
  </div>;
}
