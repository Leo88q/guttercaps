import type { Page } from '@playwright/test';

export const TEST_WALLET = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
export async function installTestWallet(page: Page, mode: 'wallet' | 'api' | 'forbid' = 'forbid') {
  await page.addInitScript(({ mode }) => {
    // Wallet Standard test double; no private key or chain transaction. API mode returns
    // dummy signature bytes to an intercepted verifier; they are never sent to a real server.
    const listeners = new Set<(event: unknown) => void>();
    const account = { address: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', publicKey: new Uint8Array(32).fill(1), chains: ['solana:devnet', 'solana:mainnet'], features: ['solana:signMessage', 'solana:signTransaction'] };
    let connected = false;
    const wallet = {
      version: '1.0.0', name: 'Localization Test Wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
      chains: account.chains,
      get accounts() { return connected ? [account] : []; },
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => { connected = true; listeners.forEach(fn => fn({ accounts: [account] })); return { accounts: [account] }; } },
        'standard:disconnect': { version: '1.0.0', disconnect: async () => { connected = false; listeners.forEach(fn => fn({ accounts: [] })); } },
        'standard:events': { version: '1.0.0', on: (_event: string, listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
        'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs: { message: Uint8Array }[]) => { if (mode === 'forbid') throw new Error('Unexpected message signing in mock UI test'); if (mode === 'wallet') throw new Error('User rejected the request.'); return inputs.map(input => ({ signedMessage: input.message, signature: new Uint8Array(64) })); } },
        'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async () => { throw new Error('Unexpected transaction signing in UI test'); } },
      },
    };
    const register = (api: { register: (wallet: unknown) => void }) => api.register(wallet);
    window.addEventListener('wallet-standard:app-ready', event => register((event as CustomEvent).detail));
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  }, { mode });
}
