/**
 * Phase-G store-launch preflight (docs/MINIMAL-LAUNCH-CHECKLIST.md фаза 8).
 *
 * Offline, zero-network: validates that a production environment for the
 * phase-G launch is complete and self-consistent BEFORE anything is deployed
 * or built. It mirrors (does not replace) the backend's own production
 * assertions in backend/src/config.ts — this gate catches the same class of
 * mistake at release time, including the client build flags the backend
 * cannot see.
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

  // ---- backend phase-G core (mirrors config.ts productionProblems, phase G)
  if (env.LAUNCH_PHASE !== 'g') err(`LAUNCH_PHASE must be "g" for the minimal store launch (got "${env.LAUNCH_PHASE ?? ''}")`);
  if (!isPubkey(env.TREASURY_WALLET)) err('TREASURY_WALLET must be a valid pubkey (pack payments land there)');
  if (!isPubkey(env.SHARED_MERKLE_TREE)) err('SHARED_MERKLE_TREE must be a valid pubkey (scripts/setup-minimal.ts --execute prints it)');
  if (!isPubkey(env.CG_MINT)) err('CG_MINT must be a valid pubkey ($CG pack rail + staking payouts)');
  if (!env.MINT_AUTHORITY_KEYPAIR) err('MINT_AUTHORITY_KEYPAIR is required (paid orders would never mint; in prod this key lives in KMS)');
  if (!env.CRANK_KEYPAIR) err('CRANK_KEYPAIR is required (the crank worker hosts the phase-G mint tick — without it the API stays green while paid orders never mint; first live devnet run, 2026-10-25)');
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

  // ---- backend production hygiene (subset that strands a launch silently)
  if ((env.SESSION_SECRET ?? '').length < 32) err('SESSION_SECRET must be ≥ 32 chars');
  if (env.COOKIE_SECURE !== '1' && env.COOKIE_SECURE !== 'true') err('COOKIE_SECURE must be enabled (https deployment)');
  if (!env.DB_PATH || env.DB_PATH === ':memory:') err('DB_PATH must be explicit and persistent');
  if (env.FINALITY_ASSUME === '1') err('FINALITY_ASSUME=1 is a dev shortcut — payments must wait for finalized transactions');
  if (!isHttps(env.SOLANA_RPC_URL)) warn('SOLANA_RPC_URL should be an https provider endpoint (Helius), not a public cluster URL');
  if (!isHttps(env.METAPLEX_DAS_RPC_URL)) err('METAPLEX_DAS_RPC_URL must be an https DAS endpoint (ownership, proofs and burn verification read through it)');
  if (env.RATE_LIMIT === '0') err('RATE_LIMIT=0 disables every abuse budget');

  // ---- client build flags (baked at build time; the backend cannot see them)
  if (env.VITE_LAUNCH_PHASE !== 'g') err(`VITE_LAUNCH_PHASE must be "g" in the store build (got "${env.VITE_LAUNCH_PHASE ?? ''}") — client and backend phases must match`);
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
  if (okRes.errors.length > 0) throw new Error(`selftest: complete env flagged: ${okRes.errors.join('; ')}`);
  const empty = evaluateLaunch({});
  if (empty.errors.length < 8) throw new Error(`selftest: empty env under-flagged (${empty.errors.length})`);
  const mismatched = evaluateLaunch({ ...good, VITE_LAUNCH_PHASE: 'full' });
  if (!mismatched.errors.some((e) => e.includes('VITE_LAUNCH_PHASE'))) throw new Error('selftest: phase mismatch not caught');
  const noCrank = evaluateLaunch({ ...good, CRANK_KEYPAIR: undefined });
  if (!noCrank.errors.some((e) => e.includes('CRANK_KEYPAIR'))) throw new Error('selftest: missing crank key not caught');
  const badKey = evaluateLaunch({ ...good, CORE_COLLECTION_2: 'not-a-key' });
  if (!badKey.errors.some((e) => e.includes('CORE_COLLECTION_2'))) throw new Error('selftest: bad collection key not caught');
  console.log('launch-check selftest OK: complete env passes, empty/mismatched/corrupt envs fail');
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
