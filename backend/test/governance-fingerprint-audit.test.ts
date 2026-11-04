// Reproducer (было): canary governance-ключей сравнивала 48-битные префиксы, поэтому ключ, у которого
// первые шесть байт совпадают со старым, был невидим для `changes(program_authority_fingerprint[1h])`.
//
//   backend/src/governance-metrics.ts:40-47   keyFingerprint = first 6 bytes as an integer
//   ops/monitoring/alerts.yml:205-211         ProgramAuthorityRotated = changes(...) > 0, severity page
//   backend/src/governance-metrics.ts:11-21   the header promises "pages on any rotation even if the
//                                             indexer is down"
//
// Найти 32-байтный ключ с заданным 6-байтным префиксом — это ≈2^24 случайных ключей (секунды-минуты на
// гриндe), а тот, кто может ротировать ключ, — ровно тот, кому нужно это скрыть. Путь через индексер
// (`AuthorityChangeIndexed`) пейджит, пока индексер жив, — то есть дыра была именно в НЕЗАВИСИМОМ пути,
// ради которого алерт и существует.
//
// Находка 70 исправлена: отпечаток — первые 96 бит sha256 от ключа, разложенные в два числа по 48 бит
// (`program_authority_fingerprint` + `program_authority_fingerprint_lo`). Сравнивается пара, поэтому
// подбор ключа под отпечаток упирается в 2^96, а `0` остался отдельным случаем «ключа нет».
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { keyFingerprint, keyFingerprints } from '../src/governance-metrics.ts';

/** Ключ с тем же 6-байтным префиксом, что и у `old`, но с другим хвостом. */
function twinWithSamePrefix(old: PublicKey): PublicKey {
  const raw = old.toBytes();
  return new PublicKey(new Uint8Array([...raw.slice(0, 6), 0xde, 0xad, 0xbe, 0xef, ...raw.slice(10)]));
}

describe('governance key fingerprint', () => {
  it('два разных ключа с общим 6-байтным префиксом различимы (находка 70)', () => {
    const old = Keypair.generate().publicKey;
    const twin = twinWithSamePrefix(old);
    const a = keyFingerprints(old);
    const b = keyFingerprints(twin);
    expect(twin.equals(old)).toBe(false);
    // Префикс действительно общий — это и был весь отпечаток раньше.
    expect([...old.toBytes()].slice(0, 6)).toEqual([...twin.toBytes()].slice(0, 6));
    // Пара (hi, lo) расходится: сравнение пары покрывает ключ целиком.
    expect({ ...b }).not.toEqual({ ...a });
    console.log(JSON.stringify({ old: old.toBase58(), twin: twin.toBase58(), oldFp: a, twinFp: b }));
  });

  it('ключи, различающиеся одним младшим битом, дают разные отпечатки', () => {
    const base = Keypair.generate().publicKey.toBytes();
    const flipped = new Uint8Array(base);
    flipped[31] ^= 0x01;
    expect(keyFingerprints(new PublicKey(flipped))).not.toEqual(keyFingerprints(new PublicKey(base)));
  });

  it('старшая половина — то, что экспортирует `program_authority_fingerprint`', () => {
    const key = Keypair.generate().publicKey;
    expect(keyFingerprint(key)).toBe(keyFingerprints(key).hi);
  });

  it('«ключа нет» — отдельный случай: обе половины 0', () => {
    expect(keyFingerprints(PublicKey.default)).toEqual({ hi: 0, lo: 0 });
    expect(keyFingerprint(PublicKey.default)).toBe(0);
    const real = keyFingerprints(Keypair.generate().publicKey);
    expect(real.hi).toBeGreaterThan(0);
    expect(real.lo).toBeGreaterThan(0);
  });

  it('алерт сравнивает обе половины, а сервер экспортирует обе серии', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const repo = join(__dirname, '..', '..');
    const alerts = readFileSync(join(repo, 'ops/monitoring/alerts.yml'), 'utf8');
    expect(alerts).toMatch(/changes\(program_authority_fingerprint\[1h\]\) > 0 or changes\(program_authority_fingerprint_lo\[1h\]\) > 0/);
    const server = readFileSync(join(repo, 'backend/src/server.ts'), 'utf8');
    expect(server).toContain("registerScrape('program_authority_fingerprint_lo'");
  });
});
