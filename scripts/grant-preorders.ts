// Launch-day delivery for the mainnet pre-sale (docs/preorder-beta.md).
//
// The backend never signs grants — it only ENCODES them (admin.ts contract, Squads-gated
// admin flow): this script calls the same `proposeDelivery` that `POST /admin/preorders/delivery`
// exposes, straight against the indexer DB, and prints the unsigned instruction pairs. The
// Squads multisig (2/3) is the only signer on the result.
//
// Run (tsx loader, same convention as the other ops scripts):
//
//   node --no-warnings=ExperimentalWarning --import tsx scripts/grant-preorders.ts queue
//       list paid reservations awaiting on-chain delivery (oldest first).
//
//   node --no-warnings=ExperimentalWarning --import tsx scripts/grant-preorders.ts delivery \
//       --admin <GameConfig admin pubkey> --oracle <Switchboard oracle pubkey> \
//       [--recent-slot <finalized slot>] [--batch 10] [--queue <pubkey>] [--db <path>] [--out file.json]
//       encode [init_grant_randomness, grant_preorder_pack] for up to `batch` paid rows (max 25).
//       `oracle` must come from the pinned Switchboard queue for the deployed build (same rule as a
//       purchase — verify-deploy pins it into the program bytes); without --recent-slot the script
//       fetches a finalized slot from MAINNET_RPC_URL itself.
//
// Safety rails: the encoded `grant_preorder_pack` fails on-chain unless the PreorderDrop for the
// SKU exists and is open, `granted + qty <= total`, the beneficiary has not exceeded
// `max_per_wallet`, and the nonce (= ref_id) has not been granted before — so replaying or
// tampering with the proposal cannot double-deliver. `close_preorder_drop` requires
// `granted == total` (PreorderNotExhausted), which makes the registry + refund policy auditable:
// a drop is either fully delivered or visibly unfinished.
//
// Nothing below runs on import.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Db } from '../backend/src/db.ts';
import { MAINNET_RPC_URL } from '../backend/src/config.ts';
import { proposeDelivery, deliveryQueue, type PreorderProposal } from '../backend/src/preorders.ts';
import { Connection } from '@solana/web3.js';

interface Args {
  cmd: string;
  admin?: string;
  oracle?: string;
  recentSlot?: string;
  batch?: string;
  queue?: string;
  db?: string;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cmd: argv[0] ?? '' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`missing value for ${a}`);
    i++;
    switch (key) {
      case 'admin': args.admin = value; break;
      case 'oracle': args.oracle = value; break;
      case 'recent-slot': args.recentSlot = value; break;
      case 'batch': args.batch = value; break;
      case 'queue': args.queue = value; break;
      case 'db': args.db = value; break;
      case 'out': args.out = value; break;
      default: fail(`unknown flag: ${a}`);
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(`grant-preorders: ${message}`);
  console.error('usage: scripts/grant-preorders.ts queue | delivery --admin PK --oracle PK [--recent-slot N] [--batch N] [--queue PK] [--db PATH] [--out FILE]');
  process.exit(2);
}

async function finalizedSlot(): Promise<bigint> {
  const conn = new Connection(MAINNET_RPC_URL, 'finalized');
  const slot = await conn.getSlot('finalized');
  return BigInt(slot);
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd !== 'queue' && args.cmd !== 'delivery') fail(`unknown command: ${args.cmd || '(none)'}`);
  const db = new Db(args.db ? resolve(args.db) : undefined);
  try {
    if (args.cmd === 'queue') {
      const rows = deliveryQueue(db);
      const packs = rows.reduce((n, r) => n + r.qty, 0);
      console.log(JSON.stringify({ awaiting: rows.length, packs, rows }, null, 2));
      return;
    }
    if (!args.admin) fail('--admin <pubkey> is required (the GameConfig admin, sole signer)');
    if (!args.oracle) fail('--oracle <pubkey> is required (oracle from the pinned Switchboard queue)');

    let recentSlot = args.recentSlot ? BigInt(args.recentSlot) : 0n;
    if (!recentSlot) {
      recentSlot = await finalizedSlot();
      console.error(`grant-preorders: using finalized slot ${recentSlot} from ${MAINNET_RPC_URL}`);
    }

    const proposal: PreorderProposal = proposeDelivery(db, {
      admin: args.admin,
      oracle: args.oracle,
      ...(args.queue ? { queue: args.queue } : {}),
      recentSlot: String(recentSlot),
      ...(args.batch ? { batch: Number(args.batch) } : {}),
    });

    const out = JSON.stringify({ generatedAt: new Date().toISOString(), mainnetRpc: MAINNET_RPC_URL, ...proposal }, null, 2);
    if (args.out) {
      writeFileSync(resolve(args.out), `${out}\n`);
      console.error(`grant-preorders: wrote ${proposal.items.length} reservation(s) / ${proposal.instructions.length} instruction(s) to ${args.out}`);
    }
    console.log(out);
  } finally {
    db.close();
  }
};

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`grant-preorders: ${message}`);
  process.exit(1);
});
