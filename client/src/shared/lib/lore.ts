// Re-export of the canonical lore in `@guttercaps/economy` (see
// packages/economy/src/lore.ts). Kept at this path because the UI and the localnet
// specs import `@/shared/lib/lore`; the data itself is shared with the backend API
// so the on-chain collection, the game UI and the landing page cannot drift apart.
//
// NOT for the node scripts: `@/…` is a Vite/tsconfig alias, and `npm run setup` runs under bare Node,
// which resolves only relative paths and node_modules. `scripts/setup.ts` imports
// `packages/economy/src/lore.ts` directly — importing *this* file from a script is what broke the
// `setup` stage of `scripts/mac-devnet.sh` (ERR_MODULE_NOT_FOUND: Cannot find package '@/shared').
export {
  COLLECTIONS, RARITY_ORDER, chipNameFor, findCollectionBySymbol,
  type ChipLore, type CollectionLore,
} from '@guttercaps/economy';

import { useMemo } from 'react';
import { COLLECTIONS as CANONICAL, type CollectionLore } from '@guttercaps/economy';
import { t, useT, type TFn, type MessageKey } from '@/shared/i18n';

/** Only presentation is localized; mint metadata, symbols, IDs and artwork paths stay canonical. */
export function localizedCollection(index: number, translate: TFn = t): CollectionLore | undefined {
  const source = CANONICAL[index];
  if (!source) return undefined;
  const text = (field: string) => translate(`catalog.d${index}.${field}` as MessageKey);
  return {
    ...source,
    name: text('name'), district: text('district'), theme: text('theme'), history: text('history'),
    caps: source.caps.map((cap, rarity) => ({
      ...cap,
      name: translate(`catalog.c${index}r${rarity}.name` as MessageKey),
      desc: translate(`catalog.c${index}r${rarity}.desc` as MessageKey),
    })),
  };
}

export function useCollections(): CollectionLore[] {
  const translate = useT();
  return useMemo(() => CANONICAL.map((_, i) => localizedCollection(i, translate)!), [translate]);
}
