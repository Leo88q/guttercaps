// Cosmetics at the function level: variant-validated service claims (skin /
// theme / emote pack / banner), season-pass state + tier claims, match emotes,
// pass XP accrual, and PASS_TRACK catalog integrity.
import { describe, expect, it, beforeEach } from 'vitest';
import {
  EMOTE_PACK_BY_ID, EMOTE_PACK_OF, PASS_TRACK, PROFILE_THEME_BY_ID, SKIN_BY_ID, passTierForXp,
} from '@guttercaps/economy';
import { Db, now } from '../src/db.ts';
import { claimService, serviceRefHash, toHex } from '../src/services.ts';
import { addPassXp, claimPassTier, passState } from '../src/pass.ts';
import { matchEmotes, postEmote } from '../src/arena.ts';
import { kp, nextSig } from './fixtures.ts';

let db: Db;
let alice: string;
let bob: string;

beforeEach(() => {
  db = new Db(':memory:');
  alice = kp();
  bob = kp();
  const t = now();
  db.run(
    `INSERT INTO seasons (id, starts_at, ends_at, server_secret, server_secret_hash) VALUES (1, ?, ?, 'aa', 'bb')`,
    t - 1000, t + 1_000_000,
  );
});

/** A finalized ServicePaid for (buyer, kind, payload). `eventIndex` lets one tx carry several payments. */
function pay(sig: string, buyer: string, kind: number, payload: Record<string, unknown>, eventIndex = 0) {
  const ref = toHex(serviceRefHash(kind, buyer, payload));
  const t = now();
  db.run(
    `INSERT INTO service_payments (signature, event_index, buyer, kind, currency, amount, burned, ref_hash, slot, block_time)
     VALUES (?, ?, ?, ?, 2, '100', '0', ?, 1, ?)`,
    sig, eventIndex, buyer, kind, ref, t,
  );
  db.run(
    `INSERT INTO events_raw (signature, ix_index, event_index, program, name, data, slot, finalized_at)
     VALUES (?, 0, ?, 'services', 'ServicePaid', '{}', 1, ?)`,
    sig, eventIndex, t,
  );
}

function chip(asset: string, owner: string, collection: number, rarity: number) {
  db.run(
    `INSERT INTO chips (asset, owner, collection_idx, rarity, origin, updated_slot) VALUES (?, ?, ?, ?, 'pack', 1)`,
    asset, owner, collection, rarity,
  );
}

function entitle(wallet: string, kind: number, payload: Record<string, unknown>, sig = nextSig(), expiresAt: number | null = null) {
  db.run(
    `INSERT INTO entitlements (wallet, kind, payload, signature, currency, amount, granted_at, expires_at)
     VALUES (?, ?, ?, ?, 2, '0', ?, ?)`,
    wallet, kind, JSON.stringify(payload), sig, now(), expiresAt,
  );
}

function match(id: string, a: string, b: string) {
  db.run(
    `INSERT INTO matches (id, season, a, b, squad_a, squad_b, power_a, power_b, league, commit_a, commit_b, status, started_at)
     VALUES (?, 1, ?, ?, '[]', '[]', 500, 500, 0, 'aa', 'bb', 'resolved', ?)`,
    id, a, b, Date.now(),
  );
}

describe('variant-validated claims', () => {
  it('skin claim writes the entitlement and paints the cap', () => {
    const asset = kp();
    chip(asset, alice, 0, 0);
    const sig = nextSig();
    pay(sig, alice, 2, { asset, skin: 'gold-rim' });
    const e = claimService(db, alice, sig, 2, { asset, skin: 'gold-rim' });
    expect(e.kind).toBe(2);
    expect(e.payload).toEqual({ asset, skin: 'gold-rim' });
    expect(db.get<{ skin: string }>(`SELECT skin FROM chips WHERE asset = ?`, asset)?.skin).toBe('gold-rim');
  });
  it('rejects unknown variant ids', () => {
    const asset = kp();
    chip(asset, alice, 0, 0);
    for (const [kind, payload] of [[2, { asset, skin: 'nope' }], [3, { theme: 'nope' }], [4, { pack: 'nope' }], [9, { collection: 99 }]] as const) {
      const sig = nextSig();
      pay(sig, alice, kind, payload as Record<string, unknown>);
      expect(() => claimService(db, alice, sig, kind, payload as Record<string, unknown>)).toThrowError(/payload needs/);
    }
  });
  it('rejects a skin claim on someone else\u2019s cap', () => {
    const asset = kp();
    chip(asset, bob, 0, 0);
    const sig = nextSig();
    pay(sig, alice, 2, { asset, skin: 'gold-rim' });
    expect(() => claimService(db, alice, sig, 2, { asset, skin: 'gold-rim' })).toThrowError(/do not own/);
  });
  it('rejects a banner claim until the set is complete', () => {
    chip(kp(), alice, 1, 0);
    const sig = nextSig();
    pay(sig, alice, 9, { collection: 1 });
    expect(() => claimService(db, alice, sig, 9, { collection: 1 })).toThrowError(/district set first/);
    for (let r = 1; r < 9; r++) chip(kp(), alice, 1, r);
    const sig2 = nextSig();
    pay(sig2, alice, 9, { collection: 1 });
    const e = claimService(db, alice, sig2, 9, { collection: 1 });
    expect(e.payload).toEqual({ collection: 1 });
  });
  it('rejects a claim whose payload differs from the payment', () => {
    const asset = kp();
    chip(asset, alice, 0, 0);
    const sig = nextSig();
    pay(sig, alice, 2, { asset, skin: 'gold-rim' });
    expect(() => claimService(db, alice, sig, 2, { asset, skin: 'hologlow' })).toThrowError(/different payload/);
  });

  // SEC-B14: one transaction can carry two `buy_service` instructions of the SAME kind (two caps, two
  // themes). Each payment has its own ref_hash, so the lookup must pick the row that matches what the
  // caller is about to grant — picking "the first unconsumed row of that kind" made the second purchase
  // unclaimable for ever: the ref_hash compare rejected the wrong row and the right one was never read.
  it('both purchases of one transaction are claimable when the kind repeats (two cap skins in one tx)', () => {
    const a = kp(), b = kp();
    chip(a, alice, 0, 0); chip(b, alice, 0, 0);
    const sig = nextSig();
    pay(sig, alice, 2, { asset: a, skin: 'gold-rim' }, 0);
    pay(sig, alice, 2, { asset: b, skin: 'hologlow' }, 1);
    // claim in the reverse order of the events, so a "first row wins" lookup cannot pass by accident
    expect(claimService(db, alice, sig, 2, { asset: b, skin: 'hologlow' }).payload).toEqual({ asset: b, skin: 'hologlow' });
    expect(claimService(db, alice, sig, 2, { asset: a, skin: 'gold-rim' }).payload).toEqual({ asset: a, skin: 'gold-rim' });
    expect(db.scalar(`SELECT COUNT(*) FROM service_payments WHERE consumed_by IS NULL`)).toBe(0);
    // and a third claim of the same transaction finds nothing left
    expect(() => claimService(db, alice, sig, 2, { asset: a, skin: 'gold-rim' })).toThrowError(/already used/);
    // a payload nobody paid for is still a mismatch, not a silent grant
    expect(() => claimService(db, alice, nextSig(), 2, { asset: a, skin: 'gold-rim' })).toThrowError(/No ServicePaid/);
  });

  // SEC-B14b: the row is spent by one conditional UPDATE, so a second reader that saw it free
  // (another API replica, a retried request) changes no row and the claim fails closed.
  it('a consumed payment cannot be spent twice, whatever the reader saw', () => {
    const asset = kp();
    chip(asset, alice, 0, 0);
    const sig = nextSig();
    pay(sig, alice, 2, { asset, skin: 'gold-rim' });
    claimService(db, alice, sig, 2, { asset, skin: 'gold-rim' });
    // the stale-reader shape: the row still looks generic (kind matches), only `consumed_by` forbids reuse
    expect(() => claimService(db, alice, sig, 2, { asset, skin: 'gold-rim' })).toThrowError(/already used/);
    expect(db.scalar(`SELECT COUNT(*) FROM entitlements WHERE wallet = ?`, alice)).toBe(1);
  });
});

describe('season pass', () => {
  it('needs an unexpired pass to claim', () => {
    addPassXp(db, 1, alice, 10_000);
    expect(() => claimPassTier(db, alice, 1, { asset: kp() })).toThrowError(/Season pass required/);
    entitle(alice, 6, {}, nextSig(), now() - 10);
    expect(() => claimPassTier(db, alice, 1, { asset: kp() })).toThrowError(/Season pass required/);
  });
  it('locks tiers above the wallet\u2019s XP', () => {
    entitle(alice, 6, {});
    expect(() => claimPassTier(db, alice, 20, { asset: kp() })).toThrowError(/needs .* XP/);
  });
  it('grants a skin tier as a kind-2 entitlement and paints the cap', () => {
    entitle(alice, 6, {});
    addPassXp(db, 1, alice, 150);
    const asset = kp();
    chip(asset, alice, 3, 4);
    const e = claimPassTier(db, alice, 1, { asset });
    expect(e.kind).toBe(2);
    expect(e.payload).toEqual({ asset, skin: 'gold-rim' });
    expect(db.get<{ skin: string }>(`SELECT skin FROM chips WHERE asset = ?`, asset)?.skin).toBe('gold-rim');
    expect(() => claimPassTier(db, alice, 1, { asset })).toThrowError(/already claimed/);
  });
  it('a banner tier still needs the completed set', () => {
    entitle(alice, 6, {});
    addPassXp(db, 1, alice, 10_000);
    expect(() => claimPassTier(db, alice, 3, {})).toThrowError(/district set first/);
  });
  it('passState reports xp, tier and claimed tiers', () => {
    entitle(alice, 6, {});
    addPassXp(db, 1, alice, 100);
    addPassXp(db, 1, alice, 150);
    const st = passState(db, alice);
    expect(st.xp).toBe(250);
    expect(st.tier).toBe(2);
    expect(st.hasPass).toBe(true);
    expect(st.claimed).toEqual([]);
  });
  it('PASS_TRACK is 20 ascending tiers over live catalog ids', () => {
    expect(PASS_TRACK).toHaveLength(20);
    expect(PASS_TRACK.map((t) => t.tier)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const xps = PASS_TRACK.map((t) => t.xp);
    expect([...xps].sort((a, b) => a - b)).toEqual(xps);
    for (const t of PASS_TRACK) {
      const r = t.reward;
      if (r.kind === 'skin') expect(SKIN_BY_ID[r.skin], `tier ${t.tier}`).toBeTruthy();
      if (r.kind === 'theme') expect(PROFILE_THEME_BY_ID[r.theme], `tier ${t.tier}`).toBeTruthy();
      if (r.kind === 'emotes') expect(EMOTE_PACK_BY_ID[r.pack], `tier ${t.tier}`).toBeTruthy();
      if (r.kind === 'banner') expect(r.collection).toBeGreaterThanOrEqual(0);
    }
    expect(passTierForXp(0)).toBe(0);
    expect(passTierForXp(5100)).toBe(20);
  });
  it('every emote belongs to exactly one pack', () => {
    const ids = new Set<string>();
    for (const p of Object.values(EMOTE_PACK_BY_ID)) {
      expect(p.emotes).toHaveLength(6);
      for (const e of p.emotes) {
        expect(ids.has(e.id)).toBe(false);
        ids.add(e.id);
        expect(EMOTE_PACK_OF[e.id]).toBe(p.id);
      }
    }
  });
});

describe('match emotes', () => {
  it('a fighter with the pack can tag, and the tag shows on the record', () => {
    match('m1', alice, bob);
    entitle(alice, 4, { pack: 'tags-v1' });
    const e = postEmote(db, alice, 'm1', { emote: 'gg' });
    expect(e).toMatchObject({ wallet: alice, side: 'a', emote: 'gg' });
    expect(matchEmotes(db, 'm1')).toHaveLength(1);
  });
  it('rejects spectators, unknown tags and missing packs', () => {
    match('m2', alice, bob);
    entitle(alice, 4, { pack: 'tags-v1' });
    expect(() => postEmote(db, kp(), 'm2', { emote: 'gg' })).toThrowError(/only the fighters/);
    expect(() => postEmote(db, alice, 'm2', { emote: 'nope' })).toThrowError(/unknown emote/);
    expect(() => postEmote(db, bob, 'm2', { emote: 'gg' })).toThrowError(/Own the emote pack/);
  });
  it('rate-limits tags to one per 5 seconds', () => {
    match('m3', alice, bob);
    entitle(alice, 4, { pack: 'tags-v1' });
    postEmote(db, alice, 'm3', { emote: 'gg' });
    expect(() => postEmote(db, alice, 'm3', { emote: 'ez' })).toThrowError(/every 5 seconds/);
  });
});
