import { t, type MessageKey } from '@/shared/i18n';

// Match application-owned diagnostic text, not arbitrary RPC prose. The original
// error, its logs and machine codes are retained for support/transaction recovery.
const FLOW_ERRORS: Record<string, MessageKey> = {
  'Wallet cannot sign messages': 'failures.walletMessages',
  'Transaction not found': 'screens.errTransactionNotFound',
  'No PackOpened event in this transaction': 'screens.errPackEvent',
  'GameConfig not found — program not initialized on this cluster': 'screens.errGameConfig',
  'This pack is currently disabled': 'screens.errPackDisabled',
  'This currency is not enabled on this cluster': 'screens.errCurrency',
  'SKR is not enabled on this cluster': 'screens.errCurrency',
  'No price available for this currency yet': 'screens.errPrice',
  'Pending pack not found (already opened?)': 'screens.errPendingPack',
  'Pending fusion not found (already revealed?)': 'screens.errPendingFusion',
  'Pending claim fusion not found (already revealed?)': 'screens.errPendingFusion',
  'Settlement account not found (opens incomplete?)': 'screens.errSettlement',
  'Nothing to refund': 'screens.errRefund',
  'Claim fusion needs exactly 3 material claims': 'screens.errThreeMaterials',
  'mint transaction landed but the claim is still unminted': 'screens.errUnminted',
  'Bubblegum proof does not fit this transaction — the app lookup table is not configured for this wallet (the crank will register this chip instead)': 'screens.errProofSize',
  'result claim vanished after a successful reveal': 'screens.errResultMissing',
  'could not find a free fusion nonce (result-claim PDA occupied 4 times in a row)': 'screens.errNonce',
};
export function describeFlowError(message: string): string | undefined {
  if (Object.hasOwn(FLOW_ERRORS, message)) return t(FLOW_ERRORS[message]);
  const collection = /^collection (\d+) (missing|not created|has no active Bubblegum tree)$/.exec(message);
  if (collection) return t(collection[2] === 'has no active Bubblegum tree' ? 'screens.errTree' : 'screens.errCollection', { n: Number(collection[1]) });
  const event = /^(?:open|commit|reveal|finalize) transaction landed without a (\w+) event$/.exec(message);
  if (event) return t('screens.errEvent', { event: event[1] });
  const pending = /^(\d+) of (\d+) chips are still unsettled \(expired claims must be cancelled first\) — re-run after cancelling$/.exec(message);
  if (pending) return t('screens.errUnsettled', { n: Number(pending[1]), total: Number(pending[2]) });
  return undefined;
}
