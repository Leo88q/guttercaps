// Deliberate operator task, not a hidden startup deletion. Review policy/holds before scheduling.
import { db } from './db.ts';
import { existsSync } from 'node:fs';
import { DB_PATH } from './config.ts';
import { loadPolicy, reapplyProfileErasures, sweepRetention } from './compliance.ts';
const task = process.argv[2];
if (!process.argv.includes('--execute') || !['retention', 'reapply-erasure'].includes(task)) {
  console.error('Usage: node --import tsx backend/src/privacy-maintenance.ts retention|reapply-erasure --execute');
  process.exit(1);
}
// Never create/migrate an unrelated or empty database and report a misleading successful sweep.
if (!existsSync(DB_PATH)) throw new Error('Maintenance requires an existing database; check DB_PATH');
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
const probe = new DatabaseSync(DB_PATH, { readOnly: true });
try {
  const row = probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('rights_requests', 'rights_messages', 'privacy_restrictions', 'age_declarations', 'wallets')").get();
  if (Number(row?.n) !== 5) throw new Error('Wrong or unmigrated database; start the updated API before scheduling maintenance');
} finally { probe.close(); }
const database = db();
try { console.log(JSON.stringify(task === 'retention' ? sweepRetention(database, loadPolicy()) : { reappliedProfiles: reapplyProfileErasures(database) })); }
finally { database.close(); }
