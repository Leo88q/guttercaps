// Reports the two wallet-side waits to the shared wait-status channel:
// adapter connect (popup / deep-link delay) and the SIWS sign-in round trip.
// Render inside <WalletProvider>; tx phases are reported by sendTx itself.
import { useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { setWait, clearWait } from '@/shared/lib/waitStatus';
import { useSessionStore } from './store/session';

export function WaitBridge() {
  const { connecting, connected } = useWallet();
  const sessionStatus = useSessionStore((s) => s.status);

  useEffect(() => {
    if (connecting) setWait('connect');
    else clearWait('connect');
  }, [connecting]);

  useEffect(() => {
    if (connected && sessionStatus === 'signing') setWait('signin');
    else clearWait('signin');
  }, [connected, sessionStatus]);

  return null;
}
