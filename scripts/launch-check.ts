/**
 * Store-launch preflight for every launch profile the product actually has.
 *
 * Offline, zero-network: validates that a production environment is complete and self-consistent BEFORE
 * anything is deployed or built. It mirrors (does not replace) the backend's own production assertions in
 * backend/src/config.ts — this gate catches the same class of mistake at release time, including the client
 * build flags the backend cannot see.
 *
 * Находка 89: этот файл был написан под один профиль — минимальный запуск фазы Г (`LAUNCH_PHASE=g`) — и
 * требовал `g` безусловно, тогда как эталонный профиль прода тогда был `LAUNCH_PHASE=full` (решение владельца
 * по находке 60; 2026-11-06 он выбрал `g`, и эталон снова фаза Г — но требовать `g` безусловно всё равно
 * нельзя: `full` и `v` остаются живыми профилями кода). Прогон префлайта на документированной конфигурации отвечал
 * «2 error(s) — NOT ready»: либо блокировал верный запуск, либо толкал выставить `g` и тем самым убрать из
 * продукта он-чейн магазин (в `g` маршруты паков идут через бэкенд, а `full` — через `chip_core::buy_pack`).
 * Теперь фаза читается, а требования выбираются по ней — как в `config.ts`:
 *   full — он-чейн магазин: ни фазовых ключей, ни фазовых маршрутов не требуется;
 *   g    — минимальный запуск: бэкенд минтит оплаченные паки (MINT_AUTHORITY_KEYPAIR, SHARED_MERKLE_TREE…);
 *   v    — тонкая программа settle (PHASEV_ORACLE_KEYPAIR, тот же CRANK_KEYPAIR…).
 * Какой профиль запускать — решение владельца, не этого скрипта; скрипт лишь перестал ему противоречить.
 *
 * Usage:
 *   npm run launch:check                 # reads process.env
 *   npm run launch:check -- --selftest   # fixture tests, no env needed
 *
 * Exit code 1 when any ERROR finding exists; warnings never fail the gate.
 */
export interface LaunchFindings {
  errors: string[];
  warnings: string[];
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isPubkey = (v: string | undefined): boolean => Boolean(v && BASE58.test(v));
const isHttps = (v: string | undefined): boolean => Boolean(v && v.startsWith('https://'));

export function evaluateLaunch(env: Record<string, string | undefined>): LaunchFindings {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);
  const warn = (m: string) => warnings.push(m);

  // ---- the launch profile, and only the requirements that profile has
  const phase = env.LAUNCH_PHASE ?? '';
  if (!['full', 'g', 'v'].includes(phase)) {
    err(`LAUNCH_PHASE must be named explicitly as one of full|g|v (got "${phase}") — full is the on-chain shop, g is the backend-minted minimal launch, v is the settle program`);
  }
  if (phase && env.VITE_LAUNCH_PHASE !== phase) {
    err(`VITE_LAUNCH_PHASE must equal LAUNCH_PHASE ("${phase}") in the store build (got "${env.VITE_LAUNCH_PHASE ?? ''}") — client and backend phases must match`);
  }
  // The key each phase cannot start without. Mirrors config.ts phaseProblems; the lists differ on purpose,
  // because the phases are different products (`pack-orders.ts`: nothing there runs while the phase is full).
  if (phase === 'g') {
    if (!isPubkey(env.TREASURY_WALLET)) err('LAUNCH_PHASE=g requires TREASURY_WALLET (pack payments land there)');
    if (!isPubkey(env.SHARED_MERKLE_TREE)) err('LAUNCH_PHASE=g requires SHARED_MERKLE_TREE (scripts/setup-minimal.ts --execute prints it)');
    if (!isPubkey(env.CG_MINT)) err('LAUNCH_PHASE=g requires CG_MINT ($CG pack rail + staking payouts)');
    if (!env.MINT_AUTHORITY_KEYPAIR) err('LAUNCH_PHASE=g requires MINT_AUTHORITY_KEYPAIR (paid orders would never mint; in prod this key lives in KMS)');
    if (!env.CRANK_KEYPAIR) err('LAUNCH_PHASE=g requires CRANK_KEYPAIR (the crank worker hosts the phase-G mint tick — without it the API stays green while paid orders never mint)');
    const featured = Number(env.PHASEG_FEATURED_COLLECTION ?? '0');
    if (!Number.isInteger(featured) || featured < 0 || featured > 7) err('PHASEG_FEATURED_COLLECTION must be an integer 0..7 and match the featured collection of the week');
    const missingCollections: number[] = [];
    for (let i = 0; i < 8; i++) {
      const v = env[`CORE_COLLECTION_${i}`];
      if (!v) missingCollections.push(i);
      else if (!isPubkey(v)) err(`CORE_COLLECTION_${i} is not a valid pubkey`);
    }
    if (missingCollections.length > 0) {
      warn(`CORE_COLLECTION_${missingCollections.join(',')} unset: those chips mint without a verified Core collection (marketplaces show them ungrouped). Run setup-minimal --execute to create all 8.`);
    }
  }
  if (phase === 'v') {
    if (!isPubkey(env.TREASURY_WALLET)) err('LAUNCH_PHASE=v requires TREASURY_WALLET (escrowed pack payments land there after settle)');
    if (!isPubkey(env.SHARED_MERKLE_TREE)) err('LAUNCH_PHASE=v requires SHARED_MERKLE_TREE (the phase-G tree carries over)');
    if (!isPubkey(env.CG_MINT)) err('LAUNCH_PHASE=v requires CG_MINT');
    if (!env.PHASEV_ORACLE_KEYPAIR) err('LAUNCH_PHASE=v requires PHASEV_ORACLE_KEYPAIR (the MINT_ORACLE that authorizes settle_pack/grant_mint)');
    if (!env.CRANK_KEYPAIR) err('LAUNCH_PHASE=v requires CRANK_KEYPAIR (the crank hosts the phase-V settle-confirm tick)');
  }
  if (phase === 'full') {
    // `full` ships the on-chain shop: no backend mint authority, no shared tree. Say what that means rather
    // than silently accepting an env where the owner expected the backend-minted flow.
    warn('LAUNCH_PHASE=full ships the on-chain shop (chip_core::buy_pack + crank reveal): phase-G/V routes answer 410, and MINT_AUTHORITY_KEYPAIR/SHARED_MERKLE_TREE are not used');
    if (!env.CRANK_KEYPAIR) err('LAUNCH_PHASE=full requires CRANK_KEYPAIR (the crank opens paid packs; without it a paid pack is never revealed)');
  }

  // ---- backend production hygiene (subset that strands a launch silently)
  if ((env.SESSION_SECRET ?? '').length < 32) err('SESSION_SECRET must be ≥ 32 chars');
  if (env.COOKIE_SECURE !== '1' && env.COOKIE_SECURE !== 'true') err('COOKIE_SECURE must be enabled (https deployment)');
  if (!env.DB_PATH || env.DB_PATH === ':memory:') err('DB_PATH must be explicit and persistent');
  if (env.FINALITY_ASSUME === '1') err('FINALITY_ASSUME=1 is a dev shortcut — payments must wait for finalized transactions');
  if (!isHttps(env.SOLANA_RPC_URL)) warn('SOLANA_RPC_URL should be an https provider endpoint (Helius), not a public cluster URL');
  if (!isHttps(env.METAPLEX_DAS_RPC_URL)) err('METAPLEX_DAS_RPC_URL must be an https DAS endpoint (ownership, proofs and burn verification read through it)');
  if (env.RATE_LIMIT === '0') err('RATE_LIMIT=0 disables every abuse budget');

  // ---- client build flags (baked at build time; the backend cannot see them)
  if (env.VITE_CLUSTER !== 'mainnet-beta') err(`VITE_CLUSTER must be "mainnet-beta" for the store build (got "${env.VITE_CLUSTER ?? ''}")`);
  if (env.VITE_FLAG_AGE_GATE !== 'true') err('VITE_FLAG_AGE_GATE=true is required for the money launch (18+ gate)');
  if (env.VITE_FLAG_GEO_GATE !== 'true') warn('VITE_FLAG_GEO_GATE is not "true": confirm the chosen markets allow the geo gate to stay off');
  if (!isHttps(env.VITE_RPC_URL)) warn('VITE_RPC_URL should be the https Helius endpoint with a domain allowlist (the key is public in the bundle by design)');
  if (!isHttps(env.VITE_DAS_RPC_URL)) warn('VITE_DAS_RPC_URL unset: the client DAS fallback may hit a non-DAS RPC and proofs will fail');
  if (!env.VITE_DAPP_STORE_URL) warn('VITE_DAPP_STORE_URL unset: the "Rate the game" entry stays hidden until the listing exists (set it in the first post-listing build)');
  if (env.VITE_API_MOCK === '1' || env.VITE_DEMO === '1') err('mock/demo flags must never be set in a store build');

  return { errors, warnings };
}

function selftest(): void {
  const good: Record<string, string> = {
    LAUNCH_PHASE: 'g',
    TREASURY_WALLET: 'HPMrLqDQaYbrD5Wh1X7KtoA1vF4rCnxNCPvSe8p5PQ1k',
    SHARED_MERKLE_TREE: '4hLLPXowUAxC8GTSvUuVtJDLVhphTDzZLBVSJzVKvJYC',
    CG_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    MINT_AUTHORITY_KEYPAIR: 'kms://treasury-authority',
    CRANK_KEYPAIR: '/keys/crank.json',
    PHASEG_FEATURED_COLLECTION: '3',
    SESSION_SECRET: 'x'.repeat(40),
    COOKIE_SECURE: '1',
    DB_PATH: '/data/guttercaps.db',
    METAPLEX_DAS_RPC_URL: 'https://das.example.com',
    SOLANA_RPC_URL: 'https://rpc.example.com',
    VITE_LAUNCH_PHASE: 'g',
    VITE_CLUSTER: 'mainnet-beta',
    VITE_FLAG_AGE_GATE: 'true',
    VITE_FLAG_GEO_GATE: 'true',
    VITE_RPC_URL: 'https://rpc.example.com',
    VITE_DAS_RPC_URL: 'https://das.example.com',
    VITE_DAPP_STORE_URL: 'https://store.example.com/app',
  };
  for (let i = 0; i < 8; i++) good[`CORE_COLLECTION_${i}`] = '4hLLPXowUAxC8GTSvUuVtJDLVhphTDzZLBVSJzVKvJYC';
  const okRes = evaluateLaunch(good);
  if (okRes.errors.length > 0) throw new Error(`selftest: complete phase-G env flagged: ${okRes.errors.join('; ')}`);
  const empty = evaluateLaunch({});
  // Считаем и называем: порог ловит «гейт ослеп», именованные проверки — «ослеп именно этот пункт».
  if (empty.errors.length < 7) throw new Error(`selftest: empty env under-flagged (${empty.errors.length})`);
  for (const needle of ['LAUNCH_PHASE', 'SESSION_SECRET', 'DB_PATH', 'METAPLEX_DAS_RPC_URL']) {
    if (!empty.errors.some((e) => e.includes(needle))) throw new Error(`selftest: empty env does not flag ${needle}`);
  }
  const mismatched = evaluateLaunch({ ...good, VITE_LAUNCH_PHASE: 'full' });
  if (!mismatched.errors.some((e) => e.includes('VITE_LAUNCH_PHASE'))) throw new Error('selftest: phase mismatch not caught');
  const noCrank = evaluateLaunch({ ...good, CRANK_KEYPAIR: undefined });
  if (!noCrank.errors.some((e) => e.includes('CRANK_KEYPAIR'))) throw new Error('selftest: missing crank key not caught');
  const badKey = evaluateLaunch({ ...good, CORE_COLLECTION_2: 'not-a-key' });
  if (!badKey.errors.some((e) => e.includes('CORE_COLLECTION_2'))) throw new Error('selftest: bad collection key not caught');

  // Второй живой профиль — `full` (он-чейн магазин). Эталон прода с 2026-11-06 — `g` (проверен выше как
  // `good`), но `full` обязан проходить так же: иначе профиль, в который можно откатиться, ломает гейт.
  const reference = { ...good, LAUNCH_PHASE: 'full', VITE_LAUNCH_PHASE: 'full' };
  for (const k of ['SHARED_MERKLE_TREE', 'MINT_AUTHORITY_KEYPAIR', 'PHASEG_FEATURED_COLLECTION']) delete (reference as Record<string, string | undefined>)[k];
  for (let i = 0; i < 8; i++) delete (reference as Record<string, string | undefined>)[`CORE_COLLECTION_${i}`];
  const refRes = evaluateLaunch(reference);
  if (refRes.errors.length > 0) throw new Error(`selftest: the on-chain-shop profile (full) is flagged: ${refRes.errors.join('; ')}`);
  // …а фазовые ключи в нём не требуются и не мешают: `full` — это он-чейн магазин.
  if (!refRes.warnings.some((w) => w.includes('on-chain shop'))) throw new Error('selftest: phase full does not say what it ships');
  const noCrankFull = evaluateLaunch({ ...reference, CRANK_KEYPAIR: undefined });
  if (!noCrankFull.errors.some((e) => e.includes('CRANK_KEYPAIR'))) throw new Error('selftest: phase full without the crank key not caught');
  // `v` требует свой ключ оракула, а не ключ минта фазы Г.
  const phaseV = { ...good, LAUNCH_PHASE: 'v', VITE_LAUNCH_PHASE: 'v', PHASEV_ORACLE_KEYPAIR: '/keys/oracle.json' };
  if (evaluateLaunch(phaseV).errors.length > 0) throw new Error(`selftest: complete phase-V env flagged: ${evaluateLaunch(phaseV).errors.join('; ')}`);
  if (!evaluateLaunch({ ...phaseV, PHASEV_ORACLE_KEYPAIR: undefined }).errors.some((e) => e.includes('PHASEV_ORACLE_KEYPAIR'))) {
    throw new Error('selftest: phase v without the oracle key not caught');
  }
  const bogus = evaluateLaunch({ ...good, LAUNCH_PHASE: 'beta', VITE_LAUNCH_PHASE: 'beta' });
  if (!bogus.errors.some((e) => e.includes('must be named explicitly'))) throw new Error('selftest: an unknown phase is not rejected');
  console.log('launch-check selftest OK: phase g/v/full each checked against its own keys, empty/mismatched/corrupt envs fail');
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  if (args.has('--selftest')) return selftest();
  const { errors, warnings } = evaluateLaunch(process.env);
  for (const w of warnings) console.log(`  WARN  ${w}`);
  for (const e of errors) console.log(`  ERROR ${e}`);
  if (errors.length > 0) {
    console.log(`\nlaunch-check: ${errors.length} error(s), ${warnings.length} warning(s) — NOT ready`);
    process.exit(1);
  }
  console.log(`\nlaunch-check: 0 errors, ${warnings.length} warning(s) — env is launch-complete (on-chain existence is checklist 1.4/8.1)`);
}

const isMain = process.argv[1]?.endsWith('launch-check.ts');
if (isMain) main();
