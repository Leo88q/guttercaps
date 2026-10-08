import { describeFlowError } from '@/shared/lib/flowError';
import { t, type MessageKey } from '@/shared/i18n';
import { API_ERROR_KEYS } from '@/api/errorCatalog';
import english from '@/shared/i18n/failures/en.json';
import catalog from './errorCatalog.json';
import { ARENA_ID, CHIP_CORE_ID, MARKET_ID, STAKING_ID } from './ids';
import { parseCustomError } from './anchor';
import { errorSnapshot } from './errorSnapshot';

const PROGRAMS = [
  { id: CHIP_CORE_ID.toBase58(), name: 'chip_core' as const },
  { id: MARKET_ID.toBase58(), name: 'market' as const },
  { id: STAKING_ID.toBase58(), name: 'staking' as const },
  { id: ARENA_ID.toBase58(), name: 'arena' as const },
];

/** Do not guess a program from a numeric code: different programs reuse the same numbers. */
export function describeProgramError(code: number, programId?: string): string | undefined {
  if (!Number.isSafeInteger(code) || code < 0) return undefined;
  const program = PROGRAMS.find(p => p.id === programId);
  if (!program) return undefined;
  if (code < 6000) {
    const key = `anchor_${code}`;
    return Object.hasOwn(english, key) ? `${program.name}: ${t(`failures.${key}` as MessageKey)} [${code}]` : undefined;
  }
  const entry = catalog[program.name][code - 6000];
  return entry ? `${program.name}: ${t(`failures.${entry.key}` as MessageKey)} [${code} · ${entry.name}]` : undefined;
}

/** Only actual transaction/blockhash expiration, never offer, nonce or claim expiry. */
export function isBlockhashExpired(error: unknown): boolean {
  const e = errorSnapshot(error);
  return !parseCustomError(e) && /block height exceeded|blockhash not found|TransactionExpiredBlockheightExceededError|transaction expired/i.test(e.message);
}

/** Translate known codes at render time. Original diagnostics are retained separately, never mutated. */
export function humanizeTxError(error: unknown): string {
  const e = errorSnapshot(error);
  if (e.code && Number.isInteger(e.status) && e.status! >= 400 && e.status! <= 599) {
    if (!Object.hasOwn(API_ERROR_KEYS, e.code)) return e.message || e.code;
    const summary = t(API_ERROR_KEYS[e.code as keyof typeof API_ERROR_KEYS]);
    const seconds = (e.details as { retryAfterS?: unknown } | undefined)?.retryAfterS;
    return e.code === 'rate_limited' && typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 0
      ? `${summary} ${t('failures.rateWait', { seconds })}` : summary;
  }
  if (e.code === 'switchboard_unavailable') return t('failures.switchboardUnavailable');
  if (e.code === 'proof_unavailable') return t('failures.proofUnavailable');
  if (e.code === 'blockhash_rejected') return t('failures.blockhashRejected');
  if (e.code === 'confirmation_unknown') return t('failures.confirmationUnknown');
  // Structured on-chain failures take precedence over incidental words in a wallet's prose.
  const custom = parseCustomError(e);
  if (custom) {
    const known = describeProgramError(custom.code, custom.programId);
    if (known) return known;
    return `${t('failures.programCode', { code: String(custom.code) })}${custom.programId ? ` [${custom.programId}]` : ''}${e.message ? `: ${e.message}` : ''}`;
  }
  const flowMessage = describeFlowError(e.message);
  if (flowMessage) return flowMessage;
  if (/User rejected|rejected the request|declined/i.test(e.message)) return t('errors.rejected');
  if (/insufficient lamports/i.test(e.message)) return t('ui.insufficientSol');
  if (/insufficient funds/i.test(e.message)) return t('errors.insufficient');
  if (isBlockhashExpired(e)) return t('ui.signatureExpired');
  if (/Transaction too large/i.test(e.message)) return t('ui.largeTx');
  if (/^(?:Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|fetch failed)$/.test(e.message)) return t('failures.network');
  return e.message || t('failures.unknown');
}
