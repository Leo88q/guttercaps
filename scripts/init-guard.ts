// SEC-F7 — first-caller-wins initialisation guard for `npm run setup` (scripts/setup.ts).
//
// chip_core `initialize`, arena `init_arena`, staking `init_emission` and settle `init_config` create
// singleton PDAs (`["config"]`, `["arena_config"]`, `["emission"]`, settle `["config"]`) and make THE
// CALLER the admin. Сейчас все четыре обработчика проверяют upgrade authority программы
// (`chip_core::deploy_guard`; у settle — своя копия того же разбора ProgramData, чтобы не тянуть
// chip_core в зависимости), так что окно «между deploy и setup» закрыто на цепи. Этот guard остаётся
// вторым эшелоном: он проверяет, что уже существующий singleton НАШ, — так ловится деплой, где
// authority успели передать мультисигу, и подменённый конфиг не «усыновляется» молча.
//
// Before this guard, setup.ts printed «config exists — skip» and carried on, i.e. a hijacked config
// would have been adopted silently. Now an existing singleton must belong to us: its current admin is
// the deployer wallet or one of the keys in SETUP_EXPECTED_ADMINS (e.g. the Squads multisig after the
// admin hand-over). Anything else aborts —
// the only recovery is a redeploy under fresh program ids, which is cheap BEFORE launch.
//
// Pure (base58 strings + bytes, no web3 import) so tests/security/init-guard.test.ts runs under
// `node --experimental-strip-types` with no dependencies.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58 of a 32-byte key (same output as PublicKey#toBase58). */
export function b58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

export type Singleton = 'chip_core config' | 'arena config' | 'staking emission';

/** Byte layout of the fields we check (8-byte Anchor discriminator first; see the #[account] structs under programs/). */
const LAYOUT: Record<Singleton, { admin: number; pendingAdmin?: number; treasury?: number; buyback?: number }> = {
  'chip_core config': { admin: 8, pendingAdmin: 40, treasury: 72, buyback: 104 }, // GameConfig { admin, pending_admin, treasury, buyback_wallet, … }
  'arena config': { admin: 8 },                                                     // ArenaConfig { admin, battle_oracle, … }
  'staking emission': { admin: 8 },                                                  // EmissionState { admin, cg_mint, … }
};

const ZERO = '11111111111111111111111111111111';

export interface InitGuardExpect {
  /** deployer wallet + SETUP_EXPECTED_ADMINS */
  allowedAdmins: string[];
  treasury?: string;
  buyback?: string;
}

export interface InitGuardVerdict { ok: boolean; problems: string[]; warnings: string[]; admin: string }

/** Decide whether an already-initialised singleton is ours. `data` = raw account data. */
export function assessExistingSingleton(kind: Singleton, data: Uint8Array, expect: InitGuardExpect): InitGuardVerdict {
  const l = LAYOUT[kind];
  const need = Math.max(l.admin, l.pendingAdmin ?? 0, l.treasury ?? 0, l.buyback ?? 0) + 32;
  if (data.length < need) return { ok: false, problems: [`${kind}: account is ${data.length} bytes, expected ≥ ${need} — not the account this script created`], warnings: [], admin: '' };
  const key = (o: number) => b58(data.subarray(o, o + 32));
  const allowed = new Set(expect.allowedAdmins);
  const admin = key(l.admin);
  const pending = l.pendingAdmin !== undefined ? key(l.pendingAdmin) : ZERO;
  const problems: string[] = [];
  const warnings: string[] = [];
  // pending_admin deliberately does NOT count: an attacker who front-ran the init could propose US as the
  // pending admin to make this check pass while he stays admin (and keeps his treasury) until we accept.
  if (!allowed.has(admin)) {
    problems.push(
      `${kind} already exists with admin ${admin}${pending !== ZERO ? ` (pending ${pending})` : ''}, which is neither the deployer wallet nor in SETUP_EXPECTED_ADMINS ` +
      `— somebody initialised it first (SEC-F7). Do NOT adopt it: redeploy under fresh program ids (npm run program-ids -- new / apply) and rerun setup.`,
    );
  }
  if (l.treasury !== undefined && expect.treasury && key(l.treasury) !== expect.treasury) {
    warnings.push(`${kind}: treasury on chain ${key(l.treasury)} ≠ expected ${expect.treasury} (fine only if it was changed on purpose via set_params)`);
  }
  if (l.buyback !== undefined && expect.buyback && key(l.buyback) !== expect.buyback) {
    warnings.push(`${kind}: buyback wallet on chain ${key(l.buyback)} ≠ expected ${expect.buyback} (fine only if it was changed on purpose via set_params)`);
  }
  return { ok: problems.length === 0, problems, warnings, admin };
}

/** Parse SETUP_EXPECTED_ADMINS (comma / whitespace separated base58 keys). */
export function expectedAdminsFromEnv(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** SEC-F7 on-chain gate: `initialize` / `init_arena` require the signer to be the program's upgrade
 *  authority. Reads the bincode `UpgradeableLoaderState::ProgramData` header (u32 tag 3 · u64 slot ·
 *  Option<Pubkey>); returns the authority, `null` for an immutable program, `undefined` if not ProgramData. */
export function upgradeAuthorityOf(data: Uint8Array): string | null | undefined {
  if (data.length < 45) return undefined;
  const tag = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
  if (tag !== 3) return undefined;
  if (data[12] === 0) return null;
  if (data[12] !== 1) return undefined;
  return b58(data.subarray(13, 45));
}

/** Pre-flight message for setup: why an init would fail with NotUpgradeAuthority, or null when it would pass. */
export function upgradeAuthorityProblem(program: string, programData: Uint8Array | null, wallet: string): string | null {
  if (!programData) return `${program}: no ProgramData account — deploy it with the upgradeable loader (solana program deploy) before setup (SEC-F7)`;
  const a = upgradeAuthorityOf(programData);
  if (a === undefined) return `${program}: the ProgramData account is not an upgradeable-loader ProgramData`;
  if (a === null) return `${program}: the program is immutable (no upgrade authority) — nobody can initialise it; redeploy upgradeable, run setup, then hand the authority to the multisig`;
  if (a !== wallet) return `${program}: upgrade authority is ${a}, but setup runs as ${wallet} — run setup with the deploy key (SEC-F7), then hand the authority to the multisig`;
  return null;
}

