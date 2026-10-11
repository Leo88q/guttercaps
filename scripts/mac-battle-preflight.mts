// Called after mac_backend_env in scripts/mac-devnet.sh. Never sources/writes .env itself.
// This script ONLY reads. The subsequently launched worker may settle existing Devnet battles.
async function main() {
  const workers = (process.env.WORKERS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (workers.some(w => !['crank', 'pyth', 'burn', 'reward', 'battle'].includes(w))) {
    console.log(JSON.stringify({ readOnly: true, ready: false, code: 'battle_workers_invalid' }));
    process.exitCode = 1; return;
  }
  if (!workers.includes('battle')) {
    console.log(JSON.stringify({ readOnly: true, ready: false, code: 'battle_disabled_by_workers', workers }));
    console.log('WARNING: battle worker отключён явным WORKERS; автоматического завершения боёв не будет.');
    return;
  }
  const { Connection } = await import('@solana/web3.js');
  const { RPC_URL } = await import('../backend/src/config.ts');
  const { checkMacBattle, battleSignerPublicKey, BattlePreflightError } = await import('../backend/src/battle-preflight.ts');
  try {
    const signer = battleSignerPublicKey(process.env.BATTLE_ORACLE_KEYPAIR);
    const connection = new Connection(RPC_URL, { commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }) });
    console.log(JSON.stringify(await checkMacBattle(connection, signer)));
  } catch (error) {
    console.log(JSON.stringify({ readOnly: true, ready: false,
      code: error instanceof BattlePreflightError ? error.code : 'battle_preflight_failed',
      ...(error instanceof BattlePreflightError ? error.facts : {}) }));
    process.exitCode = 1;
  }
}
main().catch(() => {
  console.log(JSON.stringify({ readOnly: true, ready: false, code: 'battle_preflight_setup_failed' }));
  process.exitCode = 1;
});
