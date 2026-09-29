import { reloadOnceForStaleChunk, clearChunkReloadFlag } from './app/RouteError';
import { Buffer } from 'buffer';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerMwa, createDefaultAuthorizationCache, createDefaultChainSelector, createDefaultWalletNotFoundHandler } from '@solana-mobile/wallet-standard-mobile';
import App from './app/App';
import { APP_NAME, SIWS_CHAIN_ID } from './app/config';
import { initI18n } from './shared/i18n';

// web3.js / Anchor / Switchboard expect a global Buffer in the browser.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

// Mobile Wallet Adapter (Android Chrome / Saga / Seeker) registers itself as a
// Wallet-Standard wallet; desktop extension wallets self-register too, so no
// explicit adapter list is needed in WalletProvider.
try {
  registerMwa({
    appIdentity: { name: APP_NAME, uri: window.location.origin, icon: 'icon-512.png' },
    authorizationCache: createDefaultAuthorizationCache(),
    chains: [SIWS_CHAIN_ID],
    chainSelector: createDefaultChainSelector(),
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  });
} catch {
  /* not on a platform that supports MWA */
}

// Resolve the UI language (persisted choice or device locale) before the first
// paint so there is no English flash for PT/ES/VI/ID/FIL/RU players.
// Stale tab after a redeploy: Vite fires this when a hashed chunk can't be loaded
// (Cloudflare Pages' SPA fallback answers with index.html → MIME error). Reload once.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  reloadOnceForStaleChunk();
});
window.setTimeout(clearChunkReloadFlag, 10_000);

void initI18n().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
