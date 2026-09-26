// Event → projection tables. Pure functions of events_raw: `npm run rebuild`
// truncates every projection table and replays the log in (slot, id) order,
// so any bug here is fixed by a replay, never by a migration.
//
// Idempotency: callers only apply events that were newly inserted into
// events_raw (INSERT … ON CONFLICT DO NOTHING + changes() check), so a
// projection sees each event exactly once even when backfill and the live
// listener overlap.
import { PublicKey } from '@solana/web3.js';
import { FEES, QUEST_CHIP_TEMPLATES } from '@guttercaps/economy';
import type { Db } from './db.ts';
import { rootCurrency, type EventData, type RawEvent } from './events.ts';
import { insertIgnore, upsert } from './sql.ts';

/**
 * Column lists of the projection tables, spelled once. `sql.ts` builds `VALUES (?, ?, …)` from the length of
 * the list, so a new column cannot be added to the insert text without being added here — which is the one
 * way this file's 20 insert sites stay consistent with each other across a dialect port (docs/09 §4.1).
 */
const COLS = {
  servicePayments: ['signature', 'event_index', 'buyer', 'kind', 'currency', 'amount', 'burned', 'ref_hash', 'slot', 'block_time'],
  packPurchases: ['buyer', 'nonce', 'sku', 'qty', 'currency', 'amount', 'randomness', 'signature', 'slot', 'block_time'],
  vouchers: ['wallet', 'nonce', 'template', 'randomness', 'signature', 'slot', 'block_time'],
  packOpens: ['signature', 'buyer', 'sku', 'nonce', 'count', 'assets', 'rarities', 'collections', 'roll_hex', 'pity_before', 'pity_after', 'slot', 'block_time'],
  fusions: ['signature', 'event_index', 'owner', 'recipe', 'materials', 'result', 'success', 'roll_bps', 'threshold_bps', 'fee_burned', 'slot', 'block_time'],
  chips: ['asset', 'owner', 'collection_idx', 'rarity', 'level', 'flags', 'lock_until', 'origin', 'origin_signature', 'minted_at', 'updated_slot'],
  paramsChanges: ['signature', 'admin', 'version', 'slot', 'block_time'],
  pauseChanges: ['signature', 'event_index', 'program', 'by_wallet', 'paused', 'slot', 'block_time'],
  authorityChanges: ['signature', 'event_index', 'program', 'kind', 'by_wallet', 'key', 'detail', 'slot', 'block_time'],
  burns: ['signature', 'event_index', 'program', 'source', 'amount', 'slot', 'block_time'],
  sales: ['signature', 'event_index', 'asset', 'seller', 'buyer', 'price', 'currency', 'fee', 'royalty', 'via_offer', 'collection_idx', 'rarity', 'slot', 'block_time'],
  battlesCreated: ['battle', 'challenger', 'wager', 'power_a', 'randomness', 'created_sig', 'created_at', 'slot'],
  battlesResolved: ['battle', 'challenger', 'wager', 'power_a', 'randomness', 'winner', 'pot', 'rake_burn', 'rake_pool', 'rake_treasury', 'result_hash', 'roll', 'status', 'created_sig', 'resolved_sig', 'resolved_at', 'slot'],
  emissionDays: ['day_index', 'year', 'schedule_cap', 'guarded', 'burn_7d_avg', 'slice_budget', 'signature', 'block_time'],
  claims: ['signature', 'event_index', 'owner', 'kind', 'amount', 'slot', 'block_time'],
  rewardClaims: ['kind', 'epoch', 'currency', 'wallet', 'amount', 'signature', 'slot'],
  sliceFundings: ['signature', 'event_index', 'by_wallet', 'kind', 'amount', 'slice_budget', 'recycled_total', 'slot', 'block_time'],
  skrFunded: ['signature', 'event_index', 'kind', 'counterparty', 'amount', 'budget', 'reserved', 'slot', 'block_time'],
  skrWithdrawn: ['signature', 'event_index', 'kind', 'counterparty', 'amount', 'budget', 'slot', 'block_time'],
  skrChanged: ['signature', 'event_index', 'kind', 'max_root_budget', 'paused', 'slot', 'block_time'],
};

export interface EventCtx {
  signature: string;
  slot: number;
  blockTime: number | null;
}

type Handler = (db: Db, e: RawEvent, c: EventCtx) => void;

const str = (v: unknown) => String(v);
const num = (v: unknown) => Number(v);
const j = (v: unknown) => JSON.stringify(v);
/**
 * Non-negative integer as a decimal string — event `u64`s arrive as decimal strings (`events.ts`), but a
 * hand-built fixture may carry a number or a bigint. Returns null when the field is absent or unparsable,
 * so a projection can skip the write instead of storing the string `"undefined"`.
 */
const numStr = (v: unknown): string | null => {
  if (typeof v === 'string') return /^\d+$/.test(v) ? v : null;
  if (typeof v === 'bigint') return v >= 0n ? v.toString() : null;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  return null;
};

const CHIP_FLAG_STAKED = 1;
const CHIP_FLAG_LISTED = 2;
const CHIP_FLAG_FUSING = 4;

/**
 * `first_seen` doubles as "member since", and a live event arrives without a block time (`onLogs` has
 * none — only the heal pass or the backfill learns it). A plain MIN would therefore pin the NULL.
 * Both sides are coalesced so the next timed event for that wallet heals the row, and a later untimed
 * event can never blank it out again.
 */
function touchWallet(db: Db, address: string, c: EventCtx) {
  db.run(
    `INSERT INTO wallets (address, first_seen) VALUES (?, ?)
     ON CONFLICT(address) DO UPDATE SET first_seen = COALESCE(
       CASE WHEN wallets.first_seen IS NULL OR excluded.first_seen IS NULL THEN NULL
            ELSE MIN(wallets.first_seen, excluded.first_seen) END,
       wallets.first_seen, excluded.first_seen)`,
    address, c.blockTime,
  );
}

function setChipFlag(db: Db, asset: string, flag: number, on: boolean, slot: number) {
  db.run(
    on ? `UPDATE chips SET flags = flags | ?, updated_slot = ? WHERE asset = ?` : `UPDATE chips SET flags = flags & ~?, updated_slot = ? WHERE asset = ?`,
    flag, slot, asset,
  );
}

const HANDLERS: Record<string, Handler> = {
  // ------------------------------------------------------------ chip_core
  ServicePaid(db, e, c) {
    const d = e.data;
    touchBySpec(db, e, c);
    db.run(
      insertIgnore('service_payments', COLS.servicePayments),
      c.signature, e.eventIndex, str(d.buyer), num(d.kind), num(d.currency), str(d.amount), str(d.burned), str(d.refHash), c.slot, c.blockTime,
    );
  },
  PackBought(db, e, c) {
    const d = e.data;
    touchBySpec(db, e, c);
    db.run(
      insertIgnore('pack_purchases', COLS.packPurchases),
      str(d.buyer), str(d.nonce), num(d.sku), num(d.qty), num(d.currency), str(d.amount), str(d.randomness), c.signature, c.slot, c.blockTime,
    );
  },
  /** (#28) A free quest-chip PendingPack — tracked apart from purchases; its `PackOpened` arrives with `sku = 0`. */
  VoucherIssued(db, e, c) {
    const d = e.data;
    touchBySpec(db, e, c);
    db.run(
      insertIgnore('vouchers', COLS.vouchers),
      str(d.wallet), str(d.nonce), num(d.template), str(d.randomness), c.signature, c.slot, c.blockTime,
    );
  },
  CompressedClaimsCreated(db, e, c) {
    const d = e.data;
    const buyer = str(d.buyer);
    const nonce = str(d.nonce);
    const claimNonces = d.claimNonces as string[];
    const count = num(d.count);
    touchBySpec(db, e, c);
    db.run(
      `INSERT INTO compressed_settlements (buyer, nonce, last_signature, last_slot, block_time)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(buyer, nonce) DO UPDATE SET last_signature = excluded.last_signature,
         last_slot = excluded.last_slot, block_time = COALESCE(excluded.block_time, compressed_settlements.block_time)`,
      buyer, nonce, c.signature, c.slot, c.blockTime,
    );
    for (let i = 0; i < count; i++) {
      db.run(
        `INSERT INTO compressed_claims (buyer, nonce, claim_nonce, pack_no, slot, block_time)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(buyer, nonce, claim_nonce) DO UPDATE SET pack_no = excluded.pack_no,
           slot = excluded.slot, block_time = COALESCE(excluded.block_time, compressed_claims.block_time)`,
        buyer, nonce, claimNonces[i], num(d.packNo), c.slot, c.blockTime,
      );
    }
    db.run(
      `UPDATE compressed_settlements
       SET total_claims = (SELECT COUNT(*) FROM compressed_claims WHERE buyer = ? AND nonce = ?)
       WHERE buyer = ? AND nonce = ?`,
      buyer, nonce, buyer, nonce,
    );
  },
  CompressedClaimCancelled(db, e, c) {
    const d = e.data;
    const buyer = str(d.buyer);
    const nonce = str(d.nonce);
    const claimNonce = str(d.claimNonce);
    touchBySpec(db, e, c);
    const wasPending = db.scalar(
      `SELECT COUNT(*) FROM compressed_claims WHERE buyer = ? AND nonce = ? AND claim_nonce = ? AND status <> 'cancelled'`,
      buyer, nonce, claimNonce,
    );
    db.run(
      `UPDATE compressed_claims SET status = 'cancelled', slot = ?, block_time = COALESCE(?, block_time)
       WHERE buyer = ? AND nonce = ? AND claim_nonce = ?`,
      c.slot, c.blockTime, buyer, nonce, claimNonce,
    );
    if (wasPending) {
      db.run(`UPDATE compressed_settlements SET cancelled_claims = cancelled_claims + 1, last_signature = ?, last_slot = ?, block_time = COALESCE(?, block_time) WHERE buyer = ? AND nonce = ?`, c.signature, c.slot, c.blockTime, buyer, nonce);
    }
  },
  CompressedChipMinted(db, e, c) {
    const d = e.data;
    const buyer = str(d.buyer);
    const claimNonce = str(d.claimNonce);
    touchBySpec(db, e, c);
    db.run(
      `UPDATE compressed_claims SET status = CASE WHEN status IN ('registered', 'cancelled') THEN status ELSE 'minted' END,
         collection_idx = ?, rarity = ?, level = ?, game_index = ?, mint_signature = ?, slot = ?,
         block_time = COALESCE(?, block_time)
       WHERE buyer = ? AND claim_nonce = ?`,
      num(d.collectionIdx), num(d.rarity), num(d.level), str(d.gameIndex), c.signature, c.slot, c.blockTime, buyer, claimNonce,
    );
  },
  CompressedChipRegistered(db, e, c) {
    const d = e.data;
    const buyer = str(d.owner);
    const claimNonce = str(d.claimNonce);
    touchBySpec(db, e, c);
    const previous = db.get<{ status: string }>(
      `SELECT status FROM compressed_claims WHERE buyer = ? AND claim_nonce = ?`,
      buyer, claimNonce,
    );
    const wasRegistered = previous?.status === 'registered';
    db.run(
      `UPDATE compressed_claims SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'registered' END, asset = ?, collection_idx = ?, rarity = ?, level = ?,
         register_signature = ?, slot = ?, block_time = COALESCE(?, block_time)
       WHERE buyer = ? AND claim_nonce = ?`,
      str(d.asset), num(d.collectionIdx), num(d.rarity), num(d.level), c.signature, c.slot, c.blockTime, buyer, claimNonce,
    );
    if (!wasRegistered && previous?.status !== 'cancelled') {
      db.run(`UPDATE compressed_settlements SET registered_claims = registered_claims + 1, last_signature = ?, last_slot = ?, block_time = COALESCE(?, block_time) WHERE buyer = ? AND nonce = (SELECT nonce FROM compressed_claims WHERE buyer = ? AND claim_nonce = ?)`, c.signature, c.slot, c.blockTime, buyer, buyer, claimNonce);
    }
    db.run(
      upsert('chips', COLS.chips, ['asset'], ['owner = excluded.owner', 'collection_idx = excluded.collection_idx', 'rarity = excluded.rarity', 'level = excluded.level', 'flags = excluded.flags', 'lock_until = excluded.lock_until', 'updated_slot = excluded.updated_slot', 'origin_signature = excluded.origin_signature', 'minted_at = COALESCE(chips.minted_at, excluded.minted_at)']),
      str(d.asset), buyer, num(d.collectionIdx), num(d.rarity), num(d.level), num(d.flags), Number(d.lockUntil), 'compressed', c.signature, c.blockTime, c.slot,
    );
    // The mint number (`{symbol} #{game_index}`, market "Low #" / `indexMin`/`indexMax`). A compressed chip's
    // registration event carries it, so this row never enters the crank's back-fill queue.
    const gameIndex = numStr(d.gameIndex);
    if (gameIndex !== null) db.run(`UPDATE chips SET game_index = ? WHERE asset = ?`, gameIndex, str(d.asset));
  },
  CompressedPackSettled(db, e, c) {
    const d = e.data;
    const buyer = str(d.buyer);
    const nonce = str(d.nonce);
    touchBySpec(db, e, c);
    db.run(
      `UPDATE compressed_settlements SET status = ?, last_signature = ?, last_slot = ?, block_time = COALESCE(?, block_time)
       WHERE buyer = ? AND nonce = ?`,
      d.refunded ? 'refunded' : 'settled', c.signature, c.slot, c.blockTime, buyer, nonce,
    );
  },
  PackOpened(db, e, c) {
    const d = e.data;
    const count = num(d.count);
    const assets = (d.assets as string[]).slice(0, count);
    const rarities = (d.rarities as number[]).slice(0, count);
    const collections = (d.collections as number[]).slice(0, count);
    const buyer = str(d.buyer);
    touchBySpec(db, e, c);
    db.run(
      insertIgnore('pack_opens', COLS.packOpens),
      c.signature, buyer, num(d.sku), str(d.nonce), count, j(assets), j(rarities), j(collections), str(d.roll), num(d.pityBefore), num(d.pityAfter), c.slot, c.blockTime,
    );
    // (#28) a voucher open carries sku 0 too — the (wallet, nonce) tells them apart; its lock comes from the template
    const voucher = num(d.sku) === 0 ? db.get<{ template: number }>(`SELECT template FROM vouchers WHERE wallet = ? AND nonce = ?`, buyer, str(d.nonce)) : undefined;
    const soulboundDays = voucher ? (QUEST_CHIP_TEMPLATES[voucher.template]?.soulboundDays ?? 0) : num(d.sku) === 0 ? 7 : 0; // Starter: 7 days (chip_core packs.rs)
    const soulbound = soulboundDays > 0;
    const origin = voucher ? 'voucher' : 'pack';
    // lock_until is derived from the mint time, which a live (untimed) event does not have yet — so the
    // patcher recomputes it from `minted_at` and needs the same day count (see `patchLateTimes`)
    for (let i = 0; i < count; i++) {
      db.run(
        // `minted_at`/`lock_until` are only ever filled, never blanked: an open seen live carries no block
        // time, and the timed re-read must heal the row rather than leave it undated (see patchLateTimes).
        upsert('chips', COLS.chips, ['asset'], [
          'owner = excluded.owner', 'collection_idx = excluded.collection_idx', 'rarity = excluded.rarity',
          'updated_slot = excluded.updated_slot',
          'minted_at = COALESCE(chips.minted_at, excluded.minted_at)',
          'lock_until = CASE WHEN chips.lock_until = 0 AND excluded.lock_until <> 0 THEN excluded.lock_until ELSE chips.lock_until END',
        ]),
        assets[i], buyer, collections[i], rarities[i], 1, soulbound ? 8 : 0, soulbound && c.blockTime ? c.blockTime + soulboundDays * 86_400 : 0, origin, c.signature, c.blockTime, c.slot,
      );
    }
    if (voucher) db.run(`UPDATE vouchers SET status = 'opened' WHERE wallet = ? AND nonce = ?`, buyer, str(d.nonce));
    else db.run(`UPDATE pack_purchases SET opened = opened + 1, status = CASE WHEN opened + 1 >= qty THEN 'opened' ELSE status END WHERE buyer = ? AND nonce = ?`, buyer, str(d.nonce));
  },
  PackCancelled(db, e) {
    const d = e.data;
    db.run(`UPDATE pack_purchases SET status = 'cancelled' WHERE buyer = ? AND nonce = ?`, str(d.buyer), str(d.nonce));
    db.run(`UPDATE vouchers SET status = 'cancelled' WHERE wallet = ? AND nonce = ?`, str(d.buyer), str(d.nonce));
  },
  ChipFused(db, e, c) {
    const d = e.data;
    const owner = str(d.owner);
    const materials = d.materials as string[];
    const success = Boolean(d.success);
    const result = str(d.result);
    const hasResult = success && result !== '11111111111111111111111111111111';
    touchBySpec(db, e, c);
    db.run(
      insertIgnore('fusions', COLS.fusions),
      c.signature, e.eventIndex, owner, num(d.recipe), j(materials), hasResult ? result : null, success ? 1 : 0, num(d.rollBps), num(d.thresholdBps), str(d.feeBurned), c.slot, c.blockTime,
    );
    // The commit half sets F_FUSING (ChipFlagsChanged is not emitted for it), the settle half clears it here.
    if (success) {
      for (const m of materials) db.run(`UPDATE chips SET burned_at = ?, flags = flags & ~?, updated_slot = ? WHERE asset = ?`, c.blockTime ?? 0, CHIP_FLAG_FUSING, c.slot, m);
    } else {
      // Failure: the `refund_on_fail` lowest asset keys (byte order) survive — mirrors fusion.rs.
      const recipe = num(d.recipe);
      const refund = recipe >= 4 ? 1 : 0; // recipes 4..7 (<100 % success) refund one material
      const sorted = [...materials].sort((a, b) => cmpBase58Bytes(a, b));
      const survivors = new Set(sorted.slice(0, refund));
      for (const m of materials) {
        if (survivors.has(m)) db.run(`UPDATE chips SET flags = flags & ~?, updated_slot = ? WHERE asset = ?`, CHIP_FLAG_FUSING, c.slot, m);
        else db.run(`UPDATE chips SET burned_at = ?, flags = flags & ~?, updated_slot = ? WHERE asset = ?`, c.blockTime ?? 0, CHIP_FLAG_FUSING, c.slot, m);
      }
    }
    if (hasResult) {
      const mat = db.get<{ collection_idx: number; rarity: number }>(`SELECT collection_idx, rarity FROM chips WHERE asset = ?`, materials[0]);
      const rarity = mat ? mat.rarity + 1 : num(d.recipe) + 1;
      const collection = mat?.collection_idx ?? 0;
      db.run(
        upsert('chips', COLS.chips, ['asset'], ['owner = excluded.owner', 'updated_slot = excluded.updated_slot']),
        result, owner, collection, rarity, 1, 0, 0, 'fusion', c.signature, c.blockTime, c.slot,
      );
    }
  },
  /**
   * SEC-G04: claim-based fusion (`fuse_compressed_claims`). Same `fusions` row shape as `ChipFused` (quests'
   * `fusions` metric and the activity feed read that table), `materials` = the three consumed claim PDAs,
   * `result` = the new settlement-free claim PDA. Claim recipes are always 100 %, so roll = 0 / threshold =
   * 10 000. Materials are settlement-free by construction (SEC-G03), so there is no `compressed_claims` row
   * to flip; the result claim shows up in `chips` once it is minted + registered (`CompressedChipRegistered`).
   */
  CompressedClaimsFused(db, e, c) {
    const d = e.data;
    touchBySpec(db, e, c);
    db.run(
      insertIgnore('fusions', COLS.fusions),
      c.signature, e.eventIndex, str(d.owner), num(d.recipe), j(d.materials as string[]), str(d.resultClaim), 1, 0, 10_000, str(d.feeBurned), c.slot, c.blockTime,
    );
  },
  /** H3 commit: no row (the pending fusion closes at reveal) — but the owner is active even if the reveal never lands. */
  ClaimFusionCommitted(db, e, c) {
    touchBySpec(db, e, c);
  },
  /**
   * H3: randomized claim fusion (`fuse_claims_commit` / `fuse_claims_reveal`). Same `fusions` row
   * shape as `ChipFused` with the REAL roll/threshold (unlike the always-100 % atomic path);
   * `materials` = the three consumed claim PDAs, `result` = the new settlement-free claim PDA
   * (null on failure — the program emits the default pubkey). Materials are settlement-free by
   * construction (SEC-G03), so there is no `compressed_claims` row to flip; the result claim shows
   * up in `chips` once it is minted + registered (`CompressedChipRegistered`). Failed fusions keep
   * `refund_on_fail` survivors alive on chain, but unminted claim shells are not inventory, so no
   * `chips` write happens here either way.
   */
  ClaimFusionRevealed(db, e, c) {
    const d = e.data;
    const success = Boolean(d.success);
    const result = str(d.resultClaim);
    touchBySpec(db, e, c);
    db.run(
      insertIgnore('fusions', COLS.fusions),
      c.signature, e.eventIndex, str(d.owner), num(d.recipe), j(d.materials as string[]),
      success && result !== '11111111111111111111111111111111' ? result : null, success ? 1 : 0,
      num(d.rollBps), num(d.thresholdBps), str(d.feeBurned), c.slot, c.blockTime,
    );
  },
  ChipFlagsChanged(db, e, c) {
    const d = e.data;
    db.run(`UPDATE chips SET flags = ?, lock_until = ?, updated_slot = ? WHERE asset = ?`, num(d.flags), Number(d.lockUntil), c.slot, str(d.asset));
  },
  ParamsChanged(db, e, c) {
    const d = e.data;
    db.run(insertIgnore('params_changes', COLS.paramsChanges), c.signature, str(d.admin), num(d.version), c.slot, c.blockTime);
  },
  /** SEC-H2 audit trail: who paused/un-paused which program and when (`e.program` = chip_core | staking | arena). */
  PauseChanged(db, e, c) {
    const d = e.data;
    db.run(insertIgnore('pause_changes', COLS.pauseChanges), c.signature, e.eventIndex, e.program, str(d.by), d.paused ? 1 : 0, c.slot, c.blockTime);
  },
  // SEC-G05 governance audit trail. One `authority_changes` row per rotated role, so a query like
  // "who is the quest oracle since when" is a plain `WHERE kind = ?` and the alerting side can count rows.
  PauserChanged(db, e, c) { authorityChange(db, e, c, [['pauser', 'pauser']], 'by'); },
  AdminProposed(db, e, c) { authorityChange(db, e, c, [['admin_proposed', 'newAdmin']], 'by'); },
  AdminAccepted(db, e, c) { authorityChange(db, e, c, [['admin', 'newAdmin']], 'oldAdmin'); },
  CollectionCreated(db, e, c) { authorityChange(db, e, c, [['collection', 'coreCollection']], 'by'); },
  ArenaConfigChanged(db, e, c) { authorityChange(db, e, c, [['battle_oracle', 'battleOracle'], ['treasury_cg', 'treasuryCg']], 'by'); },
  OraclesChanged(db, e, c) {
    authorityChange(db, e, c, [['quest_oracle', 'questOracle'], ['season_oracle', 'seasonOracle'], ['set_oracle', 'setOracle'], ['burn_oracle', 'burnOracle']], 'by');
  },
  BurnReported(db, e, c) {
    const d = e.data;
    db.run(insertIgnore('burns', COLS.burns), c.signature, e.eventIndex, 'chip_core', str(d.source), str(d.amount), c.slot, c.blockTime);
  },

  // ------------------------------------------------------------ market
  ChipListed(db, e, c) {
    const d = e.data;
    touchBySpec(db, e, c);
    db.run(
      upsert('listings', ['asset', 'seller', 'price', 'currency', 'created_at', 'slot', 'signature'], ['asset'], [
        'seller = excluded.seller', 'price = excluded.price', 'currency = excluded.currency',
        'created_at = excluded.created_at', 'slot = excluded.slot', 'signature = excluded.signature',
      ]),
      str(d.asset), str(d.seller), str(d.price), num(d.currency), c.blockTime, c.slot, c.signature,
    );
    setChipFlag(db, str(d.asset), CHIP_FLAG_LISTED, true, c.slot);
    // `list` burns the fixed 0.5 $CG listing fee (market/src/lib.rs LISTING_FEE_CG, no event of its own) —
    // counted here so the burn oracle (SEC-M1) and /stats see it
    db.run(insertIgnore('burns', COLS.burns), c.signature, e.eventIndex, 'market', 'listing_fee', String(FEES.listingFeeCgMicro), c.slot, c.blockTime);
  },
  ListingUpdated(db, e, c) {
    const d = e.data;
    db.run(`UPDATE listings SET price = ?, slot = ? WHERE asset = ?`, str(d.price), c.slot, str(d.asset));
  },
  ListingCancelled(db, e, c) {
    const d = e.data;
    db.run(`DELETE FROM listings WHERE asset = ?`, str(d.asset));
    setChipFlag(db, str(d.asset), CHIP_FLAG_LISTED, false, c.slot);
  },
  ChipSold(db, e, c) {
    const d = e.data;
    const asset = str(d.asset);
    const chip = db.get<{ collection_idx: number; rarity: number }>(`SELECT collection_idx, rarity FROM chips WHERE asset = ?`, asset);
    touchBySpec(db, e, c);
    db.run(
      insertIgnore('sales', COLS.sales),
      c.signature, e.eventIndex, asset, str(d.seller), str(d.buyer), str(d.price), num(d.currency), str(d.fee), str(d.royalty), d.viaOffer ? 1 : 0, chip?.collection_idx ?? null, chip?.rarity ?? null, c.slot, c.blockTime,
    );
    db.run(`DELETE FROM listings WHERE asset = ?`, asset);
    db.run(`DELETE FROM offers WHERE asset = ? AND bidder = ?`, asset, str(d.buyer));
    db.run(`UPDATE chips SET owner = ?, flags = flags & ~?, updated_slot = ? WHERE asset = ?`, str(d.buyer), CHIP_FLAG_LISTED, c.slot, asset);
  },
  OfferMade(db, e, c) {
    const d = e.data;
    touchBySpec(db, e, c);
    db.run(
      upsert('offers', ['asset', 'bidder', 'amount', 'expires_at', 'slot'], ['asset', 'bidder'], [
        'amount = excluded.amount', 'expires_at = excluded.expires_at', 'slot = excluded.slot',
      ]),
      str(d.asset), str(d.bidder), str(d.amount), Number(d.expiresAt), c.slot,
    );
  },
  OfferCancelled(db, e) {
    const d = e.data;
    db.run(`DELETE FROM offers WHERE asset = ? AND bidder = ?`, str(d.asset), str(d.bidder));
  },

  // ------------------------------------------------------------ arena
  BattleCreated(db, e, c) {
    const d = e.data;
    touchBySpec(db, e, c);
    db.run(
      insertIgnore('battles', COLS.battlesCreated),
      str(d.battle), str(d.challenger), str(d.wager), num(d.powerA), str(d.randomness), c.signature, c.blockTime, c.slot,
    );
  },
  BattleAccepted(db, e, c) {
    const d = e.data;
    touchBySpec(db, e, c);
    db.run(`UPDATE battles SET opponent = ?, power_b = ?, status = 'accepted', slot = ? WHERE battle = ?`, str(d.opponent), num(d.powerB), c.slot, str(d.battle));
  },
  BattleResolved(db, e, c) {
    const d = e.data;
    db.run(
      `UPDATE battles SET winner = ?, pot = ?, rake_burn = ?, rake_pool = ?, rake_treasury = ?, result_hash = ?, roll = ?, status = 'resolved', resolved_sig = ?, resolved_at = ?, slot = ? WHERE battle = ?`,
      str(d.winner), str(d.pot), str(d.rakeBurn), str(d.rakePool), str(d.rakeTreasury), str(d.resultHash), str(d.roll), c.signature, c.blockTime, c.slot, str(d.battle),
    );
    // A resolved battle we never saw created (backfill gap) still counts for the leaderboard.
    db.run(
      insertIgnore('battles', COLS.battlesResolved),
      str(d.battle), str(d.winner), '0', 0, '', str(d.winner), str(d.pot), str(d.rakeBurn), str(d.rakePool), str(d.rakeTreasury), str(d.resultHash), str(d.roll), 'resolved', c.signature, c.signature, c.blockTime, c.slot,
    );
    // the burned rake slice (40 % of 5 %) feeds the emission guard through the burn oracle (SEC-M1)
    if (BigInt(str(d.rakeBurn)) > 0n) {
      db.run(insertIgnore('burns', COLS.burns), c.signature, e.eventIndex, 'arena', 'rake_burn', str(d.rakeBurn), c.slot, c.blockTime);
    }
  },
  BattleCancelled(db, e, c) {
    const d = e.data;
    db.run(`UPDATE battles SET status = 'cancelled', slot = ? WHERE battle = ?`, c.slot, str(d.battle));
  },

  // ------------------------------------------------------------ staking
  DayClosed(db, e, c) {
    const d = e.data;
    db.run(
      insertIgnore('emission_days', COLS.emissionDays),
      num(d.dayIndex), num(d.year), str(d.scheduleCap), str(d.guarded), str(d.burn7dAvg), j(d.sliceBudget), c.signature, c.blockTime,
    );
  },
  Staked(db, e, c) {
    const d = e.data;
    const owner = str(d.owner);
    touchBySpec(db, e, c);
    db.run(
      upsert('stakes', ['key', 'owner', 'kind', 'amount', 'weight', 'unlock_at', 'since', 'slot', 'active'], ['key'], [
        'amount = excluded.amount', 'weight = excluded.weight', 'unlock_at = excluded.unlock_at',
        // `since` is the first stake, not the last: a live (untimed) first touch must be healed by the timed
        // re-read, and a later top-up must not move it
        'since = COALESCE(stakes.since, excluded.since)', 'slot = excluded.slot', 'active = 1',
      ]),
      str(d.key), owner, num(d.kind), str(d.amount), str(d.weight), Number(d.unlockAt), c.blockTime, c.slot, 1,
    );
    if (num(d.kind) === 1) setChipFlag(db, str(d.key), CHIP_FLAG_STAKED, true, c.slot);
  },
  Unstaked(db, e, c) {
    const d = e.data;
    if (num(d.kind) === 1) {
      db.run(`UPDATE stakes SET active = 0, slot = ? WHERE key = ?`, c.slot, str(d.key));
      setChipFlag(db, str(d.key), CHIP_FLAG_STAKED, false, c.slot);
    } else {
      // token stake: partial unstake keeps the position; amounts are decimal strings → do the math in JS
      const row = db.get<{ amount: string }>(`SELECT amount FROM stakes WHERE key = ?`, str(d.key));
      const left = row ? BigInt(row.amount) - BigInt(str(d.amount)) : 0n;
      if (left <= 0n) db.run(`UPDATE stakes SET amount = '0', active = 0, slot = ? WHERE key = ?`, c.slot, str(d.key));
      else db.run(`UPDATE stakes SET amount = ?, slot = ? WHERE key = ?`, left.toString(), c.slot, str(d.key));
    }
    if (BigInt(str(d.penaltyBurned)) > 0n) {
      db.run(insertIgnore('burns', COLS.burns), c.signature, e.eventIndex, 'staking', 'early_exit', str(d.penaltyBurned), c.slot, c.blockTime);
    }
  },
  Claimed(db, e, c) {
    const d = e.data;
    db.run(insertIgnore('claims', COLS.claims), c.signature, e.eventIndex, str(d.owner), num(d.kind), str(d.amount), c.slot, c.blockTime);
  },
  RootPublished(db, e, c) {
    const d = e.data;
    db.run(
      upsert('reward_roots', ['kind', 'epoch', 'currency', 'root', 'budget', 'revoked', 'signature', 'slot'], ['kind', 'epoch'], [
        'root = excluded.root', 'budget = excluded.budget', 'revoked = 0', 'signature = excluded.signature', 'slot = excluded.slot',
      ]),
      num(d.kind), num(d.epoch), rootCurrency(num(d.kind)), str(d.root), str(d.budget), 0, c.signature, c.slot,
    );
  },
  RootRevoked(db, e, c) {
    const d = e.data;
    db.run(`UPDATE reward_roots SET revoked = 1, slot = ? WHERE kind = ? AND epoch = ?`, c.slot, num(d.kind), num(d.epoch));
  },
  RootClaimed(db, e, c) {
    const d = e.data;
    touchBySpec(db, e, c);
    db.run(insertIgnore('reward_claims', COLS.rewardClaims), num(d.kind), num(d.epoch), rootCurrency(num(d.kind)), str(d.wallet), str(d.amount), c.signature, c.slot);
  },
  SliceFunded(db, e, c) {
    const d = e.data;
    db.run(insertIgnore('slice_fundings', COLS.sliceFundings),
      c.signature, e.eventIndex, str(d.by), num(d.kind), str(d.amount), j(d.sliceBudget), str(d.recycledTotal), c.slot, c.blockTime);
    // not a `burns` row on purpose: the tokens come back at claim (recycled), so the guard ring must not see demand here
  },
  SkrFunded(db, e, c) {
    const d = e.data;
    db.run(insertIgnore('skr_pool_events', COLS.skrFunded),
      c.signature, e.eventIndex, 'funded', str(d.funder), str(d.amount), str(d.budget), str(d.reserved), c.slot, c.blockTime);
  },
  SkrWithdrawn(db, e, c) {
    const d = e.data;
    db.run(insertIgnore('skr_pool_events', COLS.skrWithdrawn),
      c.signature, e.eventIndex, 'withdrawn', str(d.to), str(d.amount), str(d.budget), c.slot, c.blockTime);
  },
  SkrPoolChanged(db, e, c) {
    const d = e.data;
    db.run(insertIgnore('skr_pool_events', COLS.skrChanged),
      c.signature, e.eventIndex, 'changed', str(d.maxRootBudget), d.paused ? 1 : 0, c.slot, c.blockTime);
  },
  BurnRecorded(db, e, c) {
    const d = e.data;
    db.run(insertIgnore('burns', COLS.burns), c.signature, e.eventIndex, 'staking', str(d.source), str(d.amount), c.slot, c.blockTime);
  },
  SetBonusSynced(db, e, c) {
    const d = e.data;
    db.run(upsert('set_bonus', ['owner', 'sets', 'slot'], ['owner'], ['sets = excluded.sets', 'slot = excluded.slot']), str(d.owner), num(d.sets), c.slot);
  },
};

/**
 * Which payload fields name a wallet per event — the *only* place this is written down. Both the handlers
 * (through `touchBySpec`) and the late-block-time patch read it, so "who is considered active by this
 * event" cannot drift between a live index and a rebuild. The test in `replay.test.ts` checks the field
 * names against the event specs, which is what catches a renamed payload field.
 */
export const WALLET_TOUCH_FIELDS: Record<string, readonly string[]> = {
  ServicePaid: ['buyer'], PackBought: ['buyer'], VoucherIssued: ['wallet'], PackOpened: ['buyer'],
  CompressedClaimsCreated: ['buyer'], CompressedClaimCancelled: ['buyer'], CompressedChipMinted: ['buyer'], CompressedPackSettled: ['buyer'],
  ChipFused: ['owner'], CompressedClaimsFused: ['owner'], ClaimFusionCommitted: ['owner'], ClaimFusionRevealed: ['owner'], CompressedChipRegistered: ['owner'], ChipListed: ['seller'], ChipSold: ['buyer'], OfferMade: ['bidder'],
  BattleCreated: ['challenger'], BattleAccepted: ['opponent'], RootClaimed: ['wallet'], Staked: ['owner'],
};

/** `wallets.first_seen` for every wallet an event is about. Unknown block time is fine: the heal fills it. */
function touchBySpec(db: Db, e: RawEvent, c: EventCtx) {
  for (const field of WALLET_TOUCH_FIELDS[e.name] ?? []) {
    const w = e.data[field];
    if (typeof w === 'string' && w.length > 0) touchWallet(db, w, c);
  }
}

/**
 * Heal the timestamps a live index could only guess at.
 *
 * The realtime path (`listen.ts` → `onLogs`) hands us a confirmed transaction **without a block time**, and
 * only the heal pass / backfill later learns it. `ingestTx` then finds the event already in `events_raw`,
 * fills the row's `block_time` — and, without this function, leaves every projection that was written from
 * that event holding a NULL. Those columns are what day-bucketed reads group on (the burn oracle and the
 * emission guard sum `burns.block_time`, `/stats` and the leaderboards group `sales`/`battles`, a profile
 * shows `chips.minted_at`), so a NULL row is silently missing from a daily query while `npm run rebuild`
 * would have produced the timed one — two answers to one question.
 *
 * Rows are only ever *filled*, never overwritten, and the predicate is "this is still unknown", so the
 * patch is order-insensitive and idempotent: applying it to already-timed rows is a no-op. LT-3's fixture
 * tier (`backend/test/replay.test.ts`) is what pinned this; a projection added later with a time column
 * needs a line here, and the test's "no unknown timestamps left" case is what fails if it is forgotten.
 */
export function patchLateTimes(db: Db, e: RawEvent, c: EventCtx): number {
  if (c.blockTime === null) return 0;
  const sig = c.signature, blockTime = c.blockTime, d = e.data;
  let n = 0;
  const changed = (sql: string, ...params: (string | number)[]) => Number(db.run(sql, ...params).changes);
  const fill = (table: string, col: string, keyCol = 'signature') => {
    n += changed(`UPDATE ${table} SET ${col} = ? WHERE ${keyCol} = ? AND ${col} IS NULL`, blockTime, sig);
  };
  switch (e.name) {
    case 'ServicePaid': fill('service_payments', 'block_time'); break;
    case 'PackBought': fill('pack_purchases', 'block_time'); break;
    case 'VoucherIssued': fill('vouchers', 'block_time'); break;
    case 'PackOpened':
      fill('pack_opens', 'block_time');
      // the chips this open minted carry the same origin signature
      n += changed(`UPDATE chips SET minted_at = ? WHERE origin_signature = ? AND minted_at IS NULL`, blockTime, sig);
      // a soulbound chip's lock is mint time + template days; the handler wrote 0 because the mint time was
      // unknown, and only the mint time is not enough to fix it — the day count is the handler's rule
      if (num(d.sku) === 0) {
        const v = db.get<{ template: number }>(`SELECT template FROM vouchers WHERE wallet = ? AND nonce = ?`, str(d.buyer), str(d.nonce));
        const days = v ? (QUEST_CHIP_TEMPLATES[v.template]?.soulboundDays ?? 0) : 7;
        if (days > 0) n += changed(`UPDATE chips SET lock_until = minted_at + ? WHERE origin_signature = ? AND lock_until = 0 AND (flags & 8) <> 0 AND minted_at IS NOT NULL`, days * 86_400, sig);
      }
      break;
    case 'ChipFused': {
      fill('fusions', 'block_time');
      n += changed(`UPDATE chips SET minted_at = ? WHERE origin_signature = ? AND minted_at IS NULL`, blockTime, sig);
      // the burn half writes 0 for "burned, time unknown" (0 keeps the chip dead while the time is missing),
      // so 0 — not NULL — is the predicate here; materials only, never the result chip
      const mats = ((e.data.materials as string[] | undefined) ?? []).filter((m) => typeof m === 'string' && m.length > 0);
      if (mats.length > 0) {
        const marks = mats.map(() => '?').join(', ');
        n += changed(`UPDATE chips SET burned_at = ? WHERE burned_at = 0 AND asset IN (${marks})`, blockTime, ...mats);
      }
      break;
    }
    case 'ChipListed':
      fill('listings', 'created_at');
      fill('burns', 'block_time'); // the 0.5 $CG listing fee burn rides the same tx
      break;
    case 'ChipSold': fill('sales', 'block_time'); break;
    case 'BattleCreated': fill('battles', 'created_at', 'created_sig'); break;
    case 'BattleResolved':
      fill('battles', 'resolved_at', 'resolved_sig');
      fill('burns', 'block_time');
      break;
    case 'Staked':
      // stakes has no signature column: the position is keyed by the staked account / chip
      n += changed(`UPDATE stakes SET since = ? WHERE key = ? AND since IS NULL`, blockTime, String(e.data.key));
      break;
    case 'Unstaked': fill('burns', 'block_time'); break;
    case 'Claimed': fill('claims', 'block_time'); break;
    case 'DayClosed': fill('emission_days', 'block_time'); break;
    case 'SliceFunded': fill('slice_fundings', 'block_time'); break;
    case 'SkrFunded': case 'SkrWithdrawn': case 'SkrPoolChanged': fill('skr_pool_events', 'block_time'); break;
    case 'BurnReported': case 'BurnRecorded': fill('burns', 'block_time'); break;
    case 'ParamsChanged': fill('params_changes', 'block_time'); break;
    case 'PauseChanged': fill('pause_changes', 'block_time'); break;
    case 'CompressedClaimsFused': case 'ClaimFusionRevealed': fill('fusions', 'block_time'); break;
    case 'PauserChanged': case 'AdminProposed': case 'AdminAccepted': case 'CollectionCreated': case 'ArenaConfigChanged': case 'OraclesChanged':
      fill('authority_changes', 'block_time');
      break;
    default: break; // events with no time-derived projection column
  }
  // `wallets.first_seen` is "member since": the row was created by the untimed application, so the timed
  // re-read has to fill it or the profile keeps showing nothing. touchWallet's MIN keeps the earliest.
  const before = db.scalar(`SELECT COUNT(*) FROM wallets WHERE first_seen IS NULL`);
  touchBySpec(db, e, c);
  n += Math.max(0, before - db.scalar(`SELECT COUNT(*) FROM wallets WHERE first_seen IS NULL`));
  return n;
}

/** SEC-G05: one `authority_changes` row per `[kind, payloadField]` pair; `byField` names the signer field. */
function authorityChange(db: Db, e: RawEvent, c: EventCtx, roles: readonly (readonly [kind: string, field: string])[], byField: string) {
  const d = e.data;
  const detail = JSON.stringify(d);
  for (const [kind, field] of roles) {
    db.run(insertIgnore('authority_changes', COLS.authorityChanges), c.signature, e.eventIndex, e.program, kind, str(d[byField]), str(d[field]), detail, c.slot, c.blockTime);
  }
}

/** Compare two base58 pubkeys by their byte representation (what fusion.rs sorts on). */
function cmpBase58Bytes(a: string, b: string): number {
  const A = new PublicKey(a).toBytes(), B = new PublicKey(b).toBytes();
  for (let i = 0; i < 32; i++) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
}

export function applyEvent(db: Db, e: RawEvent, c: EventCtx): boolean {
  const h = HANDLERS[e.name];
  if (!h) return false;
  h(db, e, c);
  return true;
}

export const HANDLED_EVENTS = Object.keys(HANDLERS);
export type { EventData };
