// Sign-In-With-Solana: silent when the wallet supports `signIn`, otherwise a
// plain `signMessage` over the server-issued nonce. The session store keeps
// the CSRF token; the cookie itself is HttpOnly.
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { api, isMock } from '@/api/client';
import { useSessionStore } from './store/session';
import { useUiStore } from './store/ui';
import { APP_NAME, SIWS_CHAIN_ID } from './config';
import { base58Encode } from '@/shared/lib/base58';
import { deviceFingerprint } from '@/shared/lib/fingerprint';

export function useSignIn() {
  const { publicKey, signMessage, signIn, disconnect } = useWallet();
  const setSession = useSessionStore((s) => s.set);
  const clearSession = useSessionStore((s) => s.clear);
  const status = useSessionStore((s) => s.status);
  const toast = useUiStore((s) => s.toast);
  const qc = useQueryClient();

  const run = useCallback(async () => {
    if (!publicKey) return;
    const address = publicKey.toBase58();
    setSession({ status: 'signing' });
    try {
      if (isMock()) {
        const res = await api.post('/auth/siws/verify', { address, message: 'mock', signature: 'mock' });
        setSession({ status: 'authenticated', csrf: res.csrf, wallet: res.wallet ? { ...res.wallet, address: res.wallet.address ?? address } : { address }, address });
        return;
      }
      const { nonce, statement } = await api.post('/auth/siws/nonce', { address });
      const domain = window.location.host;
      const issuedAt = new Date().toISOString();
      let message: string;
      let signature: Uint8Array;
      if (signIn) {
        try {
          const out = await signIn({ domain, address, statement: statement ?? `Sign in to ${APP_NAME}`, nonce, issuedAt, uri: window.location.origin, version: '1', chainId: SIWS_CHAIN_ID });
          message = new TextDecoder().decode(out.signedMessage);
          signature = out.signature;
        } catch (err) {
          if (!signMessage || !/invalid formatting/i.test(String((err as { message?: string })?.message ?? err))) throw err;
          message = `GUTTERCAPS sign-in (${domain}):\n${address}\n\n${statement ?? `Sign in to ${APP_NAME}`}\n\nURI: ${window.location.origin}\nVersion: 1\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
          signature = await signMessage(new TextEncoder().encode(message));
        }
      } else {
        if (!signMessage) throw new Error('Wallet cannot sign messages');
        message = `${domain} wants you to sign in with your Solana account:\n${address}\n\n${statement ?? `Sign in to ${APP_NAME}`}\n\nURI: ${window.location.origin}\nVersion: 1\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
        signature = await signMessage(new TextEncoder().encode(message));
      }
      const referrer = new URLSearchParams(window.location.search).get('ref') ?? undefined;
      // device dedupe (T-B-49): coarse, canvas-free fingerprint — the API keeps only a salted hash
      const res = await api.post('/auth/siws/verify', { address, message, signature: base58Encode(signature), referrer: referrer ?? undefined, fingerprint: deviceFingerprint() });
      setSession({ status: 'authenticated', csrf: res.csrf, wallet: res.wallet ? { ...res.wallet, address: res.wallet.address ?? address } : { address }, address });
      void qc.invalidateQueries();
    } catch (e) {
      setSession({ status: 'anonymous' });
      toast({ kind: 'error', title: { key: 'screens.signInFailed' }, error: e });
    }
  }, [publicKey, signIn, signMessage, setSession, toast, qc]);

  const signOut = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    clearSession();
    qc.clear();
    await disconnect();
  }, [clearSession, qc, disconnect]);

  return { signIn: run, signOut, status };
}

/** Auto sign-in when a wallet connects (once per address), clear when it changes. */
export function SessionGate({ children }: { children: ReactNode }) {
  const { publicKey, connected } = useWallet();
  const { signIn } = useSignIn();
  const status = useSessionStore((s) => s.status);
  const address = useSessionStore((s) => s.address);
  const clear = useSessionStore((s) => s.clear);
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    if (!connected || !publicKey) {
      if (status !== 'anonymous') clear();
      attempted.current = null;
      return;
    }
    const a = publicKey.toBase58();
    if (status === 'authenticated' && address === a) return;
    if (status === 'authenticated' && address !== a) { clear(); return; }
    if (status === 'signing' || attempted.current === a) return;
    attempted.current = a;
    void signIn();
  }, [connected, publicKey, status, address, clear, signIn]);

  return <>{children}</>;
}
