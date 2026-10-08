// Three V2 proofs + atomic randomness init exceed Solana's 1232-byte packet even with a
// static app LUT. Keep the wager atomic; prepare a reusable, wallet-owned address table
// in separate transactions instead of splitting off randomness or dropping proof nodes.
import { AddressLookupTableAccount, AddressLookupTableProgram, PublicKey, SendTransactionError, type Connection, type TransactionInstruction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { appLookupTables, fitsInTx, sendTx, TxError, type WalletLike } from '../tx';
import { checkTransactionAccess } from '../access';
import { recentLookupSlots } from '../lookupTableSlots';

const ACTIVE = 0xffff_ffff_ffff_ffffn;
const remembered = new Map<string, string[]>();
function registryKey(connection: Connection, wallet: WalletLike) {
  const endpointHash = Array.from(sha256(new TextEncoder().encode(connection.rpcEndpoint)), x => x.toString(16).padStart(2, '0')).join('');
  return `gc.arena.lookup-tables:${endpointHash}:${wallet.publicKey.toBase58()}`;
}
function readTables(key: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(saved) && saved.every(value => typeof value === 'string')) return saved;
  } catch { /* storage unavailable: in-session memory still avoids duplicate tables */ }
  return remembered.get(key) ?? [];
}
function remember(key: string, address: PublicKey) {
  const values = [...new Set([...readTables(key), address.toBase58()])];
  remembered.set(key, values);
  try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* optional persistence */ }
}

function addressesOf(ixs: TransactionInstruction[]) {
  const signers = new Set(ixs.flatMap(ix => ix.keys.filter(k => k.isSigner).map(k => k.pubkey.toBase58())));
  const keys = new Map<string, PublicKey>();
  for (const ix of ixs) for (const meta of ix.keys) if (!signers.has(meta.pubkey.toBase58())) keys.set(meta.pubkey.toBase58(), meta.pubkey);
  return [...keys.values()];
}
const missingFrom = (table: AddressLookupTableAccount, addresses: PublicKey[]) => {
  const have = new Set(table.state.addresses.map(key => key.toBase58()));
  return addresses.filter(key => !have.has(key.toBase58()));
};

/** Only the explicit RPC preflight rejection is safe to rebuild. Unknown sends,
 * confirmation errors and a wallet error merely mentioning a slot must not retry. */
function rejectedLookupSlot(error: unknown) {
  if (!(error instanceof TxError) || error.signature || !(error.cause instanceof SendTransactionError)) return false;
  const cause = error.cause;
  const logs = cause.logs ?? [];
  return cause.transactionError.message.startsWith('Transaction simulation failed:')
    && logs.includes('Program log: Instruction: CreateLookupTable')
    && logs.some(line => /^Program log: \d+ is not a recent slot$/.test(line))
    && logs.includes(`Program ${AddressLookupTableProgram.programId} failed: invalid instruction data`);
}

async function prepareTable(connection: Connection, wallet: WalletLike, addresses: PublicKey[], onPrepare?: () => void) {
  const registry = registryKey(connection, wallet);
  let table: AddressLookupTableAccount | undefined;
  for (const saved of readTables(registry).slice().reverse()) {
    let key: PublicKey;
    try { key = new PublicKey(saved); } catch { continue; }
    const value = (await connection.getAddressLookupTable(key, { commitment: 'confirmed' })).value;
    if (value?.isActive() && value.state.authority?.equals(wallet.publicKey) && value.state.addresses.length + missingFrom(value, addresses).length <= 256) {
      table = value; break;
    }
  }
  if (!table) {
    // At most one fresh-snapshot retry after an explicit rejected create. Remember the
    // address BEFORE sending so an ambiguous network result can be recovered next time.
    for (let attempt = 0; attempt < 2 && !table; attempt++) {
      const recent = await recentLookupSlots(connection);
      for (const slot of recent.slots.slice(0, 8)) {
        const [create, key] = AddressLookupTableProgram.createLookupTable({ authority: wallet.publicKey, payer: wallet.publicKey, recentSlot: slot });
        const existing = (await connection.getAddressLookupTable(key, { commitment: 'confirmed', minContextSlot: recent.contextSlot })).value;
        if (existing && (!existing.isActive() || !existing.state.authority?.equals(wallet.publicKey) || existing.state.addresses.length + missingFrom(existing, addresses).length > 256)) continue;
        remember(registry, key);
        if (!existing) {
          onPrepare?.();
          try {
            await sendTx(connection, wallet, [create], { cuLimit: 100_000, minContextSlot: recent.contextSlot });
          } catch (error) {
            if (attempt === 0 && rejectedLookupSlot(error)) break;
            throw error;
          }
        }
        table = existing ?? new AddressLookupTableAccount({ key, state: { authority: wallet.publicKey, deactivationSlot: ACTIVE, lastExtendedSlot: slot, lastExtendedSlotStartIndex: 0, addresses: [] } });
        break;
      }
    }
  }
  if (!table) throw new Error('Could not allocate an arena lookup table — retry in a later slot');
  const missing = missingFrom(table, addresses);
  for (let offset = 0; offset < missing.length; offset += 20) {
    onPrepare?.();
    await sendTx(connection, wallet, [AddressLookupTableProgram.extendLookupTable({
      lookupTable: table.key, authority: wallet.publicKey, payer: wallet.publicKey, addresses: missing.slice(offset, offset + 20),
    })], { cuLimit: 100_000 });
  }
  // New entries are usable only after the extension slot. Use the table read's own context,
  // not a different RPC node's current slot, and check all entries really reached this node.
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await connection.getAddressLookupTable(table.key, { commitment: 'confirmed' });
    if (result.value?.isActive() && missingFrom(result.value, addresses).length === 0 && result.context.slot > result.value.state.lastExtendedSlot) return result.value;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Arena lookup table is not active yet — wait a few seconds and retry');
}

export async function sendArenaTx(connection: Connection, wallet: WalletLike, build: () => Promise<TransactionInstruction[]>, opts: {
  lookupTable?: PublicKey;
  onPrepare?: () => void;
  /** Read after build(), which may refresh slot-dependent instructions. */
  minContextSlot?: () => number | undefined;
} = {}) {
  let tables = await appLookupTables(connection, opts.lookupTable);
  let retriedFinalSlot = false;
  for (let pass = 0; pass < 3; pass++) {
    // Refresh proofs after slow wallet/table confirmations, not just once before preparing the LUT.
    const ixs = await build();
    if (fitsInTx(wallet.publicKey, ixs, tables)) {
      try {
        return await sendTx(connection, wallet, ixs, { cuLimit: 400_000, lookupTables: tables, minContextSlot: Math.max(opts.minContextSlot?.() ?? 0, ...tables.map(table => table.state.lastExtendedSlot + 1)) });
      } catch (error) {
        // Atomic randomness init has its own ALT create CPI. Rebuild proofs + slot too,
        // but only if the whole final transaction was explicitly rejected by preflight.
        if (!retriedFinalSlot && pass < 2 && rejectedLookupSlot(error)) { retriedFinalSlot = true; continue; }
        throw error;
      }
    }
    const addresses = addressesOf(ixs);
    const ideal = new AddressLookupTableAccount({ key: wallet.publicKey, state: {
      authority: wallet.publicKey, deactivationSlot: ACTIVE, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses,
    } });
    if (addresses.length > 256 || !fitsInTx(wallet.publicKey, ixs, [ideal])) throw new Error('Arena transaction exceeds the packet limit even with a lookup table');
    await checkTransactionAccess(wallet.publicKey.toBase58(), ixs);
    tables = [await prepareTable(connection, wallet, addresses, opts.onPrepare)];
  }
  throw new Error('Arena proof changed repeatedly during preparation — please retry');
}
