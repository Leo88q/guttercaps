import { useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletDialogProvider } from '@/shared/ui/WalletDialogProvider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RPC_URL, RPC_WS_URL } from './config';
import { useUiStore } from './store/ui';
import { SessionGate } from './session';
import '@solana/wallet-adapter-react-ui/styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 10 * 60_000,
      retry: (count, err) => {
        const status = (err as { status?: number })?.status;
        if (status && status >= 400 && status < 500) return false;
        return count < 2;
      },
      refetchOnWindowFocus: true,
    },
  },
});

export function Providers({ children }: { children: ReactNode }) {
  const rpcOverride = useUiStore((s) => s.rpcOverride);
  const endpoint = rpcOverride && /^https?:\/\//.test(rpcOverride) ? rpcOverride : RPC_URL;
  const config = useMemo(() => ({ commitment: 'confirmed' as const, wsEndpoint: RPC_WS_URL }), []);
  // Wallet Standard wallets (Phantom, Solflare, Backpack, …) self-register; MWA is registered in main.tsx.
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={endpoint} config={config}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletDialogProvider>
          <QueryClientProvider client={queryClient}>
            <SessionGate>{children}</SessionGate>
          </QueryClientProvider>
        </WalletDialogProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export { queryClient };
