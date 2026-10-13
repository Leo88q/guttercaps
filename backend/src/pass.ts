// Season pass (service kind 6): a 20-tier cosmetic track per arena season
// (economy PASS_TRACK). XP is earned by ranked play — match resolution calls
// addPassXp; nothing on the track can be bought. Tier rewards are granted as
// regular entitlements (skin/theme/emote/banner/skip) with a `pass:` signature,
// so ownership checks elsewhere keep working unchanged. Every fifth claimed tier also grants one
// Floodgrid Terminal mark (owner-approved pass-track hint source), capped by the normal hint stock.
import { GRID, PASS_TRACK, passTierForXp } from '@guttercaps/economy';
import { type Db, now } from './db.ts';
import { upsert } from './sql.ts';
import { ServiceError, districtCompleted, rowToEntitlement, type Entitlement } from './services.ts';

const iso = (s: number | null) => (s === null ? null : new Date(s * 1000).toISOString());

/** Current arena season id — the pass season is the arena season (6 weeks). Mirrors arena.currentSeason without importing it (arena imports this module for XP). */
export function passSeasonId(db: Db, t = now()): number {
  const s = db.get<{ id: number }>(`SELECT id FROM seasons WHERE starts_at <= ? AND ends_at > ? ORDER BY id DESC LIMIT 1`, t, t);
  if (s) return s.id;
  // between seasons: progress accrues to the latest one (arena rolls forward on next queue)
  const last = db.get<{ id: number }>(`SELECT id FROM seasons ORDER BY id DESC LIMIT 1`);
  if (!last) throw new ServiceError(503, 'no_season', 'No season exists yet — play a ranked match first');
  return last.id;
}

export function addPassXp(db: Db, season: number, wallet: string, amount: number): void {
  if (amount <= 0) return;
  db.run(upsert('pass_xp', ['wallet', 'season', 'xp'], ['wallet', 'season'], ['xp = pass_xp.xp + excluded.xp']), wallet, season, amount);
}

export interface PassState {
  seasonId: number; xp: number; tier: number; claimed: number[]; hasPass: boolean; passExpiresAt: string | null;
}

export function passState(db: Db, wallet: string, t = now()): PassState {
  const seasonId = passSeasonId(db, t);
  const xp = db.get<{ xp: number }>(`SELECT xp FROM pass_xp WHERE wallet = ? AND season = ?`, wallet, seasonId)?.xp ?? 0;
  const claimed = db.all<{ tier: number }>(`SELECT tier FROM pass_claims WHERE wallet = ? AND season = ? ORDER BY tier`, wallet, seasonId).map((r) => r.tier);
  const pass = db.get<{ expires_at: number | null }>(
    `SELECT expires_at FROM entitlements WHERE wallet = ? AND kind = 6 AND (expires_at IS NULL OR expires_at > ?) ORDER BY granted_at DESC LIMIT 1`, wallet, t);
  return { seasonId, xp, tier: passTierForXp(xp), claimed, hasPass: !!pass, passExpiresAt: pass ? iso(pass.expires_at) : null };
}

/** POST /me/pass/claim — grant one unlocked tier as an entitlement. Skin tiers take {asset} (an owned cap); everything else needs no params. */
export function claimPassTier(db: Db, wallet: string, tier: number, body: Record<string, unknown> | undefined, t = now()): Entitlement & { hintsGranted?: number } {
  const def = PASS_TRACK.find((x) => x.tier === tier);
  if (!def) throw new ServiceError(400, 'bad_tier', `Unknown pass tier ${tier}`);
  const seasonId = passSeasonId(db, t);
  const st = passState(db, wallet, t);
  if (!st.hasPass) throw new ServiceError(402, 'no_pass', 'Season pass required');
  if (st.xp < def.xp) throw new ServiceError(409, 'tier_locked', `Tier ${tier} needs ${def.xp} XP`);
  if (st.claimed.includes(tier)) throw new ServiceError(409, 'already_claimed', `Tier ${tier} already claimed`);
  const r = def.reward;
  let kind = 0;
  let payload: Record<string, unknown> = {};
  if (r.kind === 'skin') {
    const asset = (body as { asset?: unknown } | undefined)?.asset;
    if (typeof asset !== 'string' || !asset) throw new ServiceError(400, 'need_asset', 'Skin tiers need {asset} — the owned cap to paint');
    const chip = db.get<{ owner: string }>(`SELECT owner FROM chips WHERE asset = ? AND burned_at IS NULL`, asset);
    if (!chip || chip.owner !== wallet) throw new ServiceError(409, 'not_owner', 'You do not own that cap');
    kind = 2; payload = { asset, skin: r.skin };
  } else if (r.kind === 'theme') { kind = 3; payload = { theme: r.theme }; }
  else if (r.kind === 'emotes') { kind = 4; payload = { pack: r.pack }; }
  else if (r.kind === 'banner') {
    if (!districtCompleted(db, wallet, r.collection)) throw new ServiceError(409, 'set_not_completed', 'Finish the district set first');
    kind = 9; payload = { collection: r.collection };
  } else { kind = 8; payload = {}; }
  const signature = `pass:${seasonId}:${tier}`;
  return db.tx(() => {
    const res = db.run(
      `INSERT INTO entitlements (wallet, kind, payload, signature, currency, amount, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      wallet, kind, JSON.stringify(payload), signature, 2, '0', t, null,
    );
    if (kind === 2) db.run(`UPDATE chips SET skin = ? WHERE asset = ?`, String((payload as { skin: string }).skin), String((payload as { asset: string }).asset));
    db.run(`INSERT INTO pass_claims (wallet, season, tier, claimed_at) VALUES (?, ?, ?, ?)`, wallet, seasonId, tier, t);
    let hintsGranted = 0;
    if (tier % GRID.passHintEveryTiers === 0) {
      db.run(`INSERT INTO grid_wallet_state (wallet, hints, valves, starter_granted, total_best_stars, updated_at) VALUES (?, ?, 0, 1, 0, ?) ON CONFLICT(wallet) DO NOTHING`, wallet, GRID.hintStartStock, t);
      const before = db.get<{ hints: number }>(`SELECT hints FROM grid_wallet_state WHERE wallet = ?`, wallet)?.hints ?? GRID.hintStartStock;
      hintsGranted = Math.max(0, Math.min(1, GRID.hintStockCap - before));
      if (hintsGranted) db.run(`UPDATE grid_wallet_state SET hints = hints + ?, updated_at = ? WHERE wallet = ?`, hintsGranted, t, wallet);
    }
    const entitlement = rowToEntitlement({ id: Number(res.lastInsertRowid), kind, payload: JSON.stringify(payload), signature, currency: 2, amount: '0', granted_at: t, expires_at: null });
    return hintsGranted ? { ...entitlement, hintsGranted } : entitlement;
  });
}
