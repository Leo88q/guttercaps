// Guards against drift between packages/economy (source of truth) and the
// numbers baked into the marketing landing (scripts/landing/content.py →
// guttercaps-landing.html). Reads the built HTML, extracts the data tables
// the page renders from, and compares them with the economy model.
//   node --experimental-strip-types scripts/landing/check.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PACKS, BUNDLES } from '../../packages/economy/src/packs.ts';
import { RARITY_PROFILES } from '../../packages/economy/src/rarity.ts';
import { FUSION_RECIPES, BOOSTER } from '../../packages/economy/src/fusion.ts';
import { LOCK_TIERS } from '../../packages/economy/src/staking.ts';
import { ALLOCATION, FEES, SKR, SINKS, EMISSION_SPLIT, EMISSION_GUARD, YEARLY_EMISSION_PCT_OF_PLAY } from '../../packages/economy/src/tokenomics.ts';
import { WAGER, MATCH_REWARDS, SEASON } from '../../packages/economy/src/pvp.ts';
import { ANTI_FARM } from '../../packages/economy/src/faucets.ts';
import { SERVICES } from '../../packages/economy/src/services.ts';
import { SKR_POOL_FUNDING, SKR_TREASURY_WALLET } from '../../packages/economy/src/skrRewards.ts';
import { STALE_PACK_SLOTS } from '../../packages/economy/src/packs.ts';

const root = resolve(import.meta.dirname, '../..');
const html = readFileSync(resolve(root, 'guttercaps-landing.html'), 'utf8');
const table = (name: string) => { const i = html.indexOf(`const ${name} = `) + name.length + 9; return JSON.parse(html.slice(i, html.indexOf(';\n', i))); };
const TIERS = table('TIERS') as { key: string; odds: string; power: number; level: number; weight: number }[];
const RU = table('RU') as Record<string, string>;
const PACKS_L = table('PACKS') as { price: string; cg: string | null; en: [string, string, string[]] }[];

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { failures++; console.error(`✗ ${name}\n    landing: ${a}\n    economy: ${e}`); } else console.log(`✓ ${name}`);
};
const has = (name: string, hay: string, needle: string) => check(`${name} mentions "${needle}"`, hay.includes(needle), true);
const en = (k: string) => { const m = html.match(new RegExp(`data-i18n(?:-html)?="${k.replace('.', '\\.')}">([^<]*)`)); return m ? m[1] : ''; };
const pct = (bps: number) => (bps / 100).toString().replace(/\.0$/, '');
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

// ---- collection / cap NAMES: the landing and the on-chain lore are one source of truth ----
// docs/09 §5.3: the names used to exist twice (packages/economy/src/lore.ts and scripts/landing/collections.js)
// with nothing comparing them; a renamed cap would silently desync the store page from the contract.
import { COLLECTIONS as LORE } from '../../packages/economy/src/lore.ts';
{
  const coll = readFileSync(resolve(root, 'scripts/landing/collections.js'), 'utf8');
  const names = LORE.flatMap((c) => c.caps.map((k) => k.name));
  const gone = names.filter((n) => !coll.includes(JSON.stringify(n).slice(1, -1)));
  const missingLore = names.filter((n) => !html.includes(JSON.stringify(n)));
  check('landing collections.js carries all 72 cap names', gone, []);
  check('built landing html quotes all 72 cap names (en)', missingLore, []);
  check('landing district names', LORE.map((c) => c.name).filter((n) => !coll.includes(n)), []);
  check('lore is 8 × 9', [LORE.length, ...LORE.map((c) => c.caps.length)].filter((x, i) => (i === 0 ? x !== 8 : x !== 9)), []);
}

// ---- rarity table (Standard-pack odds, power, level, weight) ----
check('tier names', TIERS.map((t) => t.key), RARITY_PROFILES.map((r) => r.name));
check('standard odds', TIERS.map((t) => t.odds), PACKS.standard.oddsBps.map((b) => pct(b) + '%'));
check('base power', TIERS.map((t) => t.power), RARITY_PROFILES.map((r) => r.basePower));
check('max level', TIERS.map((t) => t.level), RARITY_PROFILES.map((r) => r.maxLevel));
check('stake weight', TIERS.map((t) => t.weight), RARITY_PROFILES.map((r) => r.stakeWeight));

// ---- packs ----
const skus = ['starter', 'standard', 'premium', 'limited'] as const;
check('pack prices', PACKS_L.map((p) => p.price), skus.map((k) => usd(PACKS[k].priceUsdCents)));
check('pack $CG prices', PACKS_L.map((p) => p.cg), skus.map((k) => PACKS[k].priceCgMicro == null ? null : `${(PACKS[k].priceCgMicro! / 1e6).toLocaleString('en-US').replace(',', ' ')} $CG`));
skus.forEach((k, i) => {
  const lines = PACKS_L[i].en[2].join(' | ');
  has(`${k} chips`, lines, `${PACKS[k].chips} caps`);
  has(`${k} floor`, lines, `floor ${RARITY_PROFILES[PACKS[k].floor].name}`);
  if (PACKS[k].pity) { has(`${k} hard pity`, lines, `by pack ${PACKS[k].pity!.hardAt}`); }
  if (PACKS[k].dailyCap && PACKS[k].dailyCap! > 1) has(`${k} daily cap`, lines, `Max ${PACKS[k].dailyCap} per wallet per day`);
});
const bundles = en('packs.bundles');
BUNDLES.filter((b) => b.discountBps > 0).forEach((b) => has('bundles', bundles, `×${b.qty} −${pct(b.discountBps)} %`));
has('bundles SKR', bundles, `another ${pct(FEES.skrPackDiscountBps)} % off`);
has('bundles cap', bundles, 'capped at 30 %');
has('pity note (standard)', en('rarity.pity'), `by the ${PACKS.standard.pity!.hardAt}th pack`);
has('pity note (standard soft)', en('rarity.pity'), `from the ${PACKS.standard.pity!.softStart}th`);
has('pity note (premium)', en('rarity.pity'), `Premium by ${PACKS.premium.pity!.hardAt}`);
has('pity note (limited)', en('rarity.pity'), `Limited by ${PACKS.limited.pity!.hardAt}`);

// ---- tokenomics ----
const alloc = Object.fromEntries(ALLOCATION.map((a: { bucket: string; pct: number }) => [a.bucket, a.pct]));
const legend = Array.from(html.matchAll(/<li><i style="background:#[0-9A-F]{6}"><\/i><b>(\d+) %<\/b>/g)).map((m) => Number(m[1]));
check('allocation legend', legend, ALLOCATION.map((a: { pct: number }) => a.pct));
check('allocation sums to 100', legend.reduce((a, b) => a + b, 0), 100);
const split = Array.from(html.matchAll(/data-i18n="eco\.e\d">[^<]*<\/span><div class="track"><div class="fill" style="width:(\d+)%/g)).map((m) => Number(m[1]));
check('emission split bars', split, [EMISSION_SPLIT.chipStaking, EMISSION_SPLIT.tokenStaking, EMISSION_SPLIT.quests, EMISSION_SPLIT.pvpSeason, EMISSION_SPLIT.eventsReserve]);
has('emission curve', en('eco.a1'), `${YEARLY_EMISSION_PCT_OF_PLAY[0]} % → ${YEARLY_EMISSION_PCT_OF_PLAY[YEARLY_EMISSION_PCT_OF_PLAY.length - 1]} % a year`);
has('emission guard floor', en('eco.guard'), `${EMISSION_GUARD.floorShare * 100} % of schedule`);
has('emission guard multiple', en('eco.guard'), `${EMISSION_GUARD.burnMultiple} ×`);
const sinkBars = Array.from(html.matchAll(/data-i18n="eco\.s\d">[^<]*<\/span><div class="track"><div class="fill" style="width:(\d+)%/g)).map((m) => Number(m[1]));
const sinkByName = (re: RegExp) => (SINKS as { source: string; burnPct: number }[]).find((s) => re.test(s.source))!.burnPct;
check('sink burn shares', sinkBars, [sinkByName(/fusion/i), sinkByName(/pack purchase/i), sinkByName(/unstake|penalt/i), sinkByName(/pvp|rake/i), sinkByName(/marketplace/i), sinkByName(/cosmetic|handle/i)]);

// ---- fee schedule ----
const feeCells = Array.from(html.matchAll(/<td class="num">([^<]+)<\/td>/g)).map((m) => m[1]);
check('fee table', feeCells, [`${pct(FEES.marketplaceFeeBps)} %`, `${pct(FEES.creatorRoyaltyBps)} %`, `${pct(WAGER.rakeBps)} %`, `${FEES.listingFeeCgMicro / 1e6} $CG`,
  `${usd(Math.min(...SERVICES.map((s: { priceUsdCents: number }) => s.priceUsdCents)))} – ${usd(Math.max(...SERVICES.map((s: { priceUsdCents: number }) => s.priceUsdCents)))}`, `−${pct(FEES.skrPackDiscountBps)} %`]);
has('SKR mint on page', html, SKR.mint);
has('market fact', en('mech.4f'), `${pct(FEES.marketplaceFeeBps)} % + ${pct(FEES.creatorRoyaltyBps)} % royalty`);

// ---- mechanics copy ----
const fusion = en('mech.1p');
has('fusion odds', fusion, FUSION_RECIPES.filter((r) => r.successBps < 10_000).map((r) => r.successBps / 100).join(' / ') + ' %');
has('fusion booster', fusion, `+${BOOSTER.bonusBps / 100} pp (cap ${BOOSTER.capBps / 100} %)`);
has('fusion lock', fusion, `${Math.max(...FUSION_RECIPES.map((r) => r.resultLockSeconds)) / 3600} h`);
has('fusion fee range', en('mech.1f'), `${FUSION_RECIPES[0].feeCgMicro / 1e6} → ${(FUSION_RECIPES[7].feeCgMicro / 1e6).toLocaleString('en-US').replace(',', ' ')} $CG`);
const pvp = en('mech.2p');
has('wager range', pvp, `${WAGER.minCgMicro / 1e6}–${(WAGER.maxCgMicro / 1e6).toLocaleString('en-US').replace(',', ' ')} $CG`);
has('season length', pvp, `${SEASON.weeks === 6 ? 'Six' : SEASON.weeks}-week`);
has('pvp fact', en('mech.2f'), `rake ${pct(WAGER.rakeBps)} % · ${MATCH_REWARDS.dailyRewardedMatches} rewarded matches/day`);
const staking = en('mech.3p');
has('lock boosts', staking, (['flex', 'd30', 'd90', 'd180'] as const).map((k) => LOCK_TIERS[k].boost.toFixed(1)).join(' / '));
has('early exit', staking, `${LOCK_TIERS.d30.earlyExitPenaltyBps / 100}–${LOCK_TIERS.d180.earlyExitPenaltyBps / 100} %`);
has('stake weight range', staking, `weight ${RARITY_PROFILES[0].stakeWeight} → ${RARITY_PROFILES[8].stakeWeight.toLocaleString('en-US').replace(',', ' ')}`);
const quests = en('mech.5p');
has('daily quest cap', quests, `${ANTI_FARM.dailyQuestRewardCapCgMicro / 1e6} $CG a day`);
has('weekly quest cap', quests, `${ANTI_FARM.weeklyQuestRewardCapCgMicro / 1e6} a week`);
has('stale pack slots', en('rules.5'), `${STALE_PACK_SLOTS.toLocaleString('en').replace(',', ' ')} slots`);
has('SKR prize pool share', en('eco.skr.p'), `${pct(SKR_POOL_FUNDING.packRevenueShareBps)} % of SKR pack revenue`);
has('SKR prize pool market share', en('eco.skr.p'), `${pct(SKR_POOL_FUNDING.marketFeeTreasuryShareBps)} % of SKR market fees`);
has('SKR prize pool services share', en('eco.skr.p'), `${pct(SKR_POOL_FUNDING.servicesRevenueShareBps)} % of SKR extras`);
has('SKR treasury wallet', html, SKR_TREASURY_WALLET);

// ---- legal layer (docs/09 §5.2, dapp-store/PORTAL_CHECKLIST.md) ----
// The store checklist wants resolvable Privacy/Terms URLs, and a landing whose legal links are '#' is a
// rejection letter waiting to be written. Both halves are checked: the markup must carry the links, and
// app.js must resolve them to app-hosted pages (a placeholder never resolves, it only looks tidy).
has('footer legal links', html, 'data-link="terms"');
has('footer legal links', html, 'data-link="privacy"');
has('footer age badge', html, '18+');
{
  const appjs = readFileSync(resolve(root, 'scripts/landing/app.js'), 'utf8');
  check('legal URLs derive from the app origin', [appjs.includes("['terms', '/legal/terms']"), appjs.includes("['privacy', '/legal/privacy']")], [true, true]);
  // The social handles stay '#' until they exist (that is the documented convention in the file), but a
  // legal URL must not be in that group — it has a real destination today.
  check("terms/privacy are not in the 'coming soon' group", /terms: '#'/.test(appjs) || /privacy: '#'/.test(appjs), false);
}

// ---- SEC-B4: the landing talks to one origin, and it is ours ----
// The page used to pull its webfonts from fonts.googleapis.com: a third-party request that handed every
// visitor's IP to Google while /legal/privacy promises no third-party analytics, and one the app's own
// CSP (`font-src 'self' data:`) blocked in production anyway. The fonts are now vendored in the repo
// (client/public/fonts, OFL — see scripts/vendor-fonts.ts) and inlined as data URIs, so the allowlist is
// down to the stats endpoint. Anything that adds a request to a new origin fails here, in front of a
// reviewer, instead of shipping silently to every visitor; the CSP meta is the runtime half of the same
// rule for a static host whose response headers we do not control.
{
  const ALLOWED = [{ host: 'api.guttercaps.gg', why: 'GET /stats for the live counters' }];
  const hosts = [...new Set(Array.from(html.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)).map((m) => m[1]))]
    // JSON-LD contexts and the canonical/og/twitter URLs are strings, not fetches: `schema.org`,
    // `www.w3.org`, the site's own domains and the app origin (used for links) are not requests.
    .filter((h) => !['schema.org', 'www.w3.org', 'guttercaps.gg', 'app.guttercaps.gg'].includes(h))
    .sort();
  check('every third-party host in the landing is allowlisted', hosts, ALLOWED.map((a) => a.host).sort());
  check('no Google Fonts reference', /fonts\.(googleapis|gstatic)\.com/.test(html), false);

  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  const csp = m ? m[1] : '';
  check('CSP meta present', csp.length > 0, true);
  check('CSP default-deny', /default-src 'none'/.test(csp), true);
  // no off-origin script/style/font may be named, even additively: those three are the ones a careless
  // edit reaches for, and `connect-src` already pins the only origin we do want
  check('CSP allows no external script', /script-src[^;]*https?:\/\//.test(csp), false);
  check('CSP allows no external style', /style-src[^;]*https?:\/\//.test(csp), false);
  check('CSP allows no external font', /font-src[^;]*(https?:\/\/|[*])/.test(csp), false);
  check('CSP keeps fonts self+data', /font-src 'self' data:/.test(csp), true);
  check('CSP pins the stats endpoint', /connect-src 'self' https:\/\/api\.guttercaps\.gg(;|$)/.test(csp), true);
  check('no-referrer meta', /<meta name="referrer" content="no-referrer"/.test(html), true);

  // the fonts the landing needs must be *inside* the file, not merely named: the manifest marks the
  // landing surface, and every one of those files has to be inlined (base64) or a visitor silently
  // falls back to a system font — the same failure mode the app hit with un-ranged fontsource subsets
  const manifest = JSON.parse(readFileSync(resolve(root, 'client/public/fonts/manifest.json'), 'utf8')) as {
    files: { file: string; family: string; weight: number; surfaces: string[] }[];
  };
  const landingFiles = manifest.files.filter((f) => f.surfaces.includes('landing'));
  const notInlined = landingFiles
    .filter((f) => !html.includes(readFileSync(resolve(root, 'client/public/fonts', f.file)).toString('base64')))
    .map((f) => f.file);
  check('every landing-surface font is inlined', notInlined, []);
  check('no extra font is inlined', Array.from(html.matchAll(/data:font\/woff2;base64,/g)).length, landingFiles.length);
  const inlinedFaces = new Set(Array.from(html.matchAll(/@font-face\{font-family:'([^']+)';font-style:normal;font-display:swap;font-weight:(\d+);src:url\(data:font\/woff2;base64,[^)]+\) format\('woff2'\);unicode-range:U\+/g)).map((x) => `${x[1]}@${x[2]}`));
  check('each inlined family/weight declares a unicode-range', inlinedFaces.size, new Set(landingFiles.map((f) => `${f.family}@${f.weight}`)).size);
}

// ---- i18n coverage: every EN key has a RU string, no empty strings ----
const keys = Array.from(html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)).map((m) => m[1]);
check('RU coverage', [...new Set(keys)].filter((k) => !RU[k] || !RU[k].trim()), []);

console.log(failures ? `\n${failures} landing/economy mismatch(es)` : '\nlanding matches the economy model');
process.exit(failures ? 1 : 0);
