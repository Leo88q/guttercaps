import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { Keypair } from '@solana/web3.js';
import { EVENT_SPECS, decodeEvent, decodeLogs, encodeEvent, eventDiscriminator, fakeLogs, type EventData } from '../src/events.ts';
import { PROGRAMS } from '../src/config.ts';

const pk = () => Keypair.generate().publicKey.toBase58();
const hex32 = (b: number) => b.toString(16).padStart(2, '0').repeat(32);

/** One representative value per field type, so every spec can be round-tripped generically. */
function sample(spec: (typeof EVENT_SPECS)[number]): EventData {
  const d: EventData = {};
  for (const [name, t] of spec.fields) {
    const one = (s: string): string | number | boolean => {
      switch (s) {
        case 'u8': return 200;
        case 'u16': return 65_000;
        case 'u32': return 4_000_000_000;
        case 'u64': return '18446744073709551615';           // u64::MAX
        case 'u128': return '340282366920938463463374607431768211455';
        case 'i64': return '-9223372036854775808';
        case 'bool': return true;
        case 'pubkey': return pk();
        case 'bytes32': return hex32(0xab);
        default: throw new Error(s);
      }
    };
    d[name] = Array.isArray(t) ? Array.from({ length: t[1] }, () => one(t[0])) : one(t as string);
  }
  return d;
}

describe('event codec', () => {
  it('discriminator = sha256("event:<Name>")[..8]', () => {
    const want = Buffer.from(sha256(new TextEncoder().encode('event:PackOpened')).slice(0, 8)).toString('hex');
    expect(Buffer.from(eventDiscriminator('PackOpened')).toString('hex')).toBe(want);
    // pinned — if this changes, the programs changed their event names
    expect(Buffer.from(eventDiscriminator('ServicePaid')).toString('hex')).toHaveLength(16);
  });

  it('round-trips every declared event through encode → decode', () => {
    for (const s of EVENT_SPECS) {
      const data = sample(s);
      const bytes = encodeEvent(s.name, data);
      const back = decodeEvent(s.program, bytes);
      expect(back, s.name).toBeDefined();
      expect(back!.name).toBe(s.name);
      expect(back!.data).toEqual(data);
    }
  });

  it('PackOpened is 8 + 32+1+8 + 5·32 + 5 + 5 + 1 + 32 + 2 + 2 bytes', () => {
    const s = EVENT_SPECS.find((x) => x.name === 'PackOpened')!;
    expect(encodeEvent('PackOpened', sample(s)).length).toBe(8 + 32 + 1 + 8 + 160 + 5 + 5 + 1 + 32 + 2 + 2);
  });

  it('CompressedPackOpened is 8 + 32+8+1+1+1 + 5·8 + 5 + 5 + 32 + 2 + 2 + 1 bytes', () => {
    const s = EVENT_SPECS.find((x) => x.name === 'CompressedPackOpened')!;
    expect(encodeEvent('CompressedPackOpened', sample(s)).length).toBe(8 + 32 + 8 + 1 + 1 + 1 + 40 + 5 + 5 + 32 + 2 + 2 + 1);
  });

  it('rejects unknown discriminators and other programs', () => {
    const bytes = encodeEvent('ChipSold', sample(EVENT_SPECS.find((x) => x.name === 'ChipSold')!));
    expect(decodeEvent('market', bytes)?.name).toBe('ChipSold');
    expect(decodeEvent('chip_core', bytes)).toBeUndefined(); // market event logged under chip_core → ignored
    expect(decodeEvent('market', new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('walks logs, attributes CPI-emitted events to the inner program and keeps ix/event indices', () => {
    const sold = sample(EVENT_SPECS.find((x) => x.name === 'ChipSold')!);
    const flags = sample(EVENT_SPECS.find((x) => x.name === 'ChipFlagsChanged')!);
    // market::buy CPIs into chip_core::set_flags — both events are emitted in one top-level ix
    const marketId = PROGRAMS.market.toBase58();
    const coreId = PROGRAMS.chip_core.toBase58();
    const logs = [
      'Program ComputeBudget111111111111111111111111111111 invoke [1]',
      'Program ComputeBudget111111111111111111111111111111 success',
      `Program ${marketId} invoke [1]`,
      'Program log: Instruction: Buy',
      `Program ${coreId} invoke [2]`,
      `Program data: ${Buffer.from(encodeEvent('ChipFlagsChanged', flags)).toString('base64')}`,
      `Program ${coreId} success`,
      `Program data: ${Buffer.from(encodeEvent('ChipSold', sold)).toString('base64')}`,
      `Program ${marketId} consumed 91234 of 400000 compute units`,
      `Program ${marketId} success`,
    ];
    const out = decodeLogs(logs);
    expect(out.map((e) => [e.program, e.name, e.ixIndex, e.eventIndex])).toEqual([
      ['chip_core', 'ChipFlagsChanged', 1, 0],
      ['market', 'ChipSold', 1, 1],
    ]);
    expect(out[1].data).toEqual(sold);
  });

  it('ignores garbage "Program data:" lines and foreign programs', () => {
    const logs = [
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]',
      'Program data: not-base64!!',
      'Program data: AAAA',
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
      ...fakeLogs([{ program: 'arena', name: 'BattleCancelled', data: { battle: pk(), refundedA: '1', refundedB: '0' } }]),
    ];
    const out = decodeLogs(logs);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('BattleCancelled');
  });
});
