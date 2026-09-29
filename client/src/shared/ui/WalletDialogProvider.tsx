import { useMemo, useState, type ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { WalletModalContext } from '@solana/wallet-adapter-react-ui';
import { useT } from '@/shared/i18n';
import { Modal } from './primitives';

/** Keep wallet-adapter's context/selection contract, without its English-only modal. */
export function WalletDialogProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const context = useMemo(() => ({ visible, setVisible }), [visible]);
  const { wallets, select } = useWallet();
  const t = useT();
  const available = wallets.filter((w) => w.readyState !== WalletReadyState.Unsupported);
  return (
    <WalletModalContext.Provider value={context}>
      {children}
      <Modal open={visible} onClose={() => setVisible(false)} title={t('ui.chooseWallet')}>
        <div className="stack">
          {available.length === 0 && <p>{t('ui.noWallet')}</p>}
          {available.map(({ adapter }) => (
            <button className="btn row" key={adapter.name} onClick={() => { select(adapter.name); setVisible(false); }}>
              <img src={adapter.icon} width={28} height={28} alt="" />
              <span>{adapter.name}</span>
            </button>
          ))}
          <button className="btn btn-ghost" onClick={() => setVisible(false)}>{t('common.close')}</button>
        </div>
      </Modal>
    </WalletModalContext.Provider>
  );
}
