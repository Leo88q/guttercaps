// Serializable, language-neutral evidence for persisted flows and live notifications.
// Do not put translated strings into transaction state: a later locale change must still work.
export interface ErrorSnapshot {
  message: string;
  code?: string;
  status?: number;
  programId?: string;
  logs?: string[];
  details?: unknown;
}

export function errorSnapshot(error: unknown): ErrorSnapshot {
  const result: ErrorSnapshot = { message: '' };
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (current == null) break;
    if (typeof current !== 'object') { result.message = String(current); break; }
    if (seen.has(current)) break;
    seen.add(current);
    const e = current as Record<string, unknown>;
    if (typeof e.message === 'string') result.message = e.message;
    if (typeof e.code === 'string') result.code = e.code;
    if (typeof e.status === 'number') result.status = e.status;
    if (typeof e.programId === 'string') result.programId = e.programId;
    if (Array.isArray(e.logs)) result.logs = e.logs.filter((s): s is string => typeof s === 'string');
    if (e.details !== undefined) {
      // JSON-safe, with integer atoms kept as strings. Circular diagnostics become readable text.
      try { result.details = JSON.parse(JSON.stringify(e.details, (_, v) => typeof v === 'bigint' ? v.toString() : v)); }
      catch { result.details = String(e.details); }
    }
    // Structured Anchor errors may have no useful outer message.
    const anchor = e.error as { errorCode?: { number?: number } } | undefined;
    if (anchor?.errorCode && Number.isSafeInteger(anchor.errorCode.number) && !result.message.includes('custom program error:')) {
      result.message += `\ncustom program error: ${anchor.errorCode.number}`;
    }
    if (e.cause == null) {
      if (!result.message) {
        try { result.message = JSON.stringify(e); } catch { result.message = String(e); }
      }
      break;
    }
    current = e.cause;
  }
  return result;
}

export function originalErrorText(error: unknown): string {
  const e = errorSnapshot(error);
  return [e.code, e.status === undefined ? undefined : `HTTP ${e.status}`, e.programId, e.message,
    e.details === undefined ? undefined : JSON.stringify(e.details, null, 2), ...(e.logs ?? []),
  ].filter(Boolean).join('\n');
}
