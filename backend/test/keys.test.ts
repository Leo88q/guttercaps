// Накодка 91: ключ подписи читался только как путь к файлу, а `kms://…` из префлайта падал на первом
// open_pack через ENOENT — через часы после «деплой прошёл». Эти тесты держат контракт загрузчика:
// какие формы принимаются, что именно происходит с неподдерживаемой формой, и что ошибка называет
// переменную, а не путь.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import {
  KeySourceError,
  SECRET_BYTES,
  SUPPORTED_KEY_FORMS,
  keySourceProblem,
  loadSigner,
  parseKeySource,
  secretBytes,
} from '../src/keys.ts';

/** Одноразовый каталог: файлы ключей не должны появляться в репозитории. */
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'keys-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Секрет в том виде, в каком его пишет `solana-keygen` — JSON-массив из 64 чисел. */
const writeSolanaJson = (dir: string, kp: Keypair, name = 'k.json') => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return p;
};

describe('parseKeySource: три формы, названные по имени', () => {
  it('путь — форма по умолчанию, в том числе путь docker-секрета', () => {
    expect(parseKeySource('CRANK_KEYPAIR', '/run/secrets/crank_keypair')).toEqual({
      kind: 'file',
      path: '/run/secrets/crank_keypair',
      spec: '/run/secrets/crank_keypair',
    });
    expect(parseKeySource('CRANK_KEYPAIR', './secrets/crank.json')).toMatchObject({ kind: 'file', path: './secrets/crank.json' });
  });

  it('file:<path> — то же самое, сказанное явно', () => {
    expect(parseKeySource('CRANK_KEYPAIR', 'file:/run/secrets/x.json')).toMatchObject({
      kind: 'file',
      path: '/run/secrets/x.json',
    });
  });

  it('env:<NAME> — переменная окружения, а не файл', () => {
    expect(parseKeySource('MINT_AUTHORITY_KEYPAIR', 'env:MINT_AUTHORITY_SECRET')).toEqual({
      kind: 'env',
      name: 'MINT_AUTHORITY_SECRET',
      spec: 'env:MINT_AUTHORITY_SECRET',
    });
  });

  it('env: без UPPER_SNAKE-имени — отказ, а не «пустое» значение', () => {
    for (const spec of ['env:', 'env:lower_case', 'env:X']) {
      expect(() => parseKeySource('CRANK_KEYPAIR', spec)).toThrow(KeySourceError);
    }
  });

  it('kms:// и родственные схемы отвергаются по имени, с перечнем рабочих форм', () => {
    for (const scheme of ['kms', 'awskms', 'gcpkms', 'azurekms', 'vault', 'hsm']) {
      let err: unknown;
      try {
        parseKeySource('MINT_AUTHORITY_KEYPAIR', `${scheme}://treasury/authority`);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(KeySourceError);
      const msg = (err as Error).message;
      // это должна быть ошибка про форму ключа, а не про отсутствующий файл
      expect(msg).toContain('MINT_AUTHORITY_KEYPAIR');
      expect(msg).toContain(`${scheme}://`);
      expect(msg).toContain(SUPPORTED_KEY_FORMS);
      expect(msg).not.toContain('ENOENT');
    }
  });

  it('прочий URL (http://) — тоже отказ: это не ключ', () => {
    expect(() => parseKeySource('CRANK_KEYPAIR', 'https://example.com/key.json')).toThrow(/is a URL, not a key/);
  });

  it('пустое значение объясняет, что записать', () => {
    expect(() => parseKeySource('CRANK_KEYPAIR', '   ')).toThrow(/is empty/);
  });
});

describe('secretBytes: содержимое, а не путь', () => {
  it('читает solana-keygen JSON с диска', () => {
    const kp = Keypair.generate();
    const p = writeSolanaJson(tempDir(), kp);
    expect(Buffer.from(secretBytes('CRANK_KEYPAIR', p))).toEqual(Buffer.from(kp.secretKey));
  });

  it('читает base64 «сырых» 64 байт из env:<NAME>', () => {
    const kp = Keypair.generate();
    const b64 = Buffer.from(kp.secretKey).toString('base64');
    const bytes = secretBytes('MINT_AUTHORITY_KEYPAIR', 'env:MINT_SECRET', { MINT_SECRET: b64 });
    expect(Buffer.from(bytes)).toEqual(Buffer.from(kp.secretKey));
  });

  it('читает JSON-массив из env:<NAME> тоже', () => {
    const kp = Keypair.generate();
    const bytes = secretBytes('CRANK_KEYPAIR', 'env:KEYP', { KEYP: JSON.stringify(Array.from(kp.secretKey)) });
    expect(Buffer.from(bytes)).toEqual(Buffer.from(kp.secretKey));
  });

  it('env: на незаданную переменную — отказ с её именем', () => {
    expect(() => secretBytes('CRANK_KEYPAIR', 'env:MISSING_KEY', {})).toThrow(/MISSING_KEY, which is not set/);
  });

  it('несуществующий файл — ошибка про переменную и монтирование, а не голый ENOENT', () => {
    let msg = '';
    try {
      secretBytes('MINT_AUTHORITY_KEYPAIR', '/run/secrets/definitely-absent.json');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('MINT_AUTHORITY_KEYPAIR');
    expect(msg).toContain('/run/secrets/definitely-absent.json');
    expect(msg).toContain('ENOENT');
    expect(msg).toContain('mount it');
  });

  it('32-байтный seed назван так же, как 64-байтный секрет: разные вещи', () => {
    const dir = tempDir();
    const p = join(dir, 'seed.json');
    writeFileSync(p, Buffer.alloc(32, 7).toString('base64'));
    expect(() => secretBytes('CRANK_KEYPAIR', p)).toThrow(/32-byte seed/);
  });

  it('base64 от JSON-файла (частая ошибка) объясняется словами, а не «неверная длина»', () => {
    const kp = Keypair.generate();
    const asText = Buffer.from(JSON.stringify(Array.from(kp.secretKey))).toString('base64');
    expect(() => secretBytes('CRANK_KEYPAIR', 'env:KEYP', { KEYP: asText })).toThrow(/encodes the text/);
  });

  it('битый JSON — отказ, а не нулевой ключ', () => {
    const p = join(tempDir(), 'broken.json');
    writeFileSync(p, '[1,2,3,');
    expect(() => secretBytes('CRANK_KEYPAIR', p)).toThrow(KeySourceError);
  });
});

describe('loadSigner: одинаковый результат из файла и из env', () => {
  it('файл и env дают один и тот же публичный ключ', () => {
    const kp = Keypair.generate();
    const p = writeSolanaJson(tempDir(), kp);
    const fromFile = loadSigner('CRANK_KEYPAIR', p);
    const fromEnv = loadSigner('CRANK_KEYPAIR', 'env:KEY', { KEY: Buffer.from(kp.secretKey).toString('base64') });
    expect(fromFile.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(fromEnv.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('незаданная переменная — отказ, который называет её', () => {
    expect(() => loadSigner('BURN_ORACLE_KEYPAIR', undefined)).toThrow(/BURN_ORACLE_KEYPAIR=.*is not set/);
    expect(() => loadSigner('BURN_ORACLE_KEYPAIR', '  ')).toThrow(/is not set/);
  });

  it('файл без прав на чтение — ошибка чтения, а не «ключ невалиден» (root в контейнере всё равно прочтёт)', () => {
    const kp = Keypair.generate();
    const p = writeSolanaJson(tempDir(), kp);
    chmodSync(p, 0o000);
    try {
      const signer = loadSigner('CRANK_KEYPAIR', p);
      // под root chmod не мешает — тогда просто проверяем, что ключ тот самый
      expect(signer.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    } catch (e) {
      expect(e).toBeInstanceOf(KeySourceError);
    }
  });
});

describe('keySourceProblem: проверка на старте, без утечки секрета', () => {
  it('незаданная переменная — не проблема этого слоя (каждая фаза решает сама)', () => {
    expect(keySourceProblem('CRANK_KEYPAIR', undefined)).toBeNull();
    expect(keySourceProblem('CRANK_KEYPAIR', '')).toBeNull();
  });

  it('рабочий ключ — null', () => {
    const kp = Keypair.generate();
    const p = writeSolanaJson(tempDir(), kp);
    expect(keySourceProblem('CRANK_KEYPAIR', p)).toBeNull();
  });

  it('сообщение об ошибке не содержит ни одного байта секрета', () => {
    const kp = Keypair.generate();
    const b64 = Buffer.from(kp.secretKey).toString('base64');
    // 63 байта вместо 64: форма верная, содержание — нет
    const broken = Buffer.from(kp.secretKey.slice(0, 63)).toString('base64');
    const msg = keySourceProblem('MINT_AUTHORITY_KEYPAIR', 'env:KEYP', { KEYP: broken });
    expect(msg).toBeTruthy();
    expect(msg).not.toContain(b64);
    // и не печатает сам секрет по кускам
    expect(msg).not.toContain(broken.slice(0, 16));
    expect(SECRET_BYTES).toBe(64);
  });

  it('проблема с формой не выдаёт себя за проблему с файлом', () => {
    const msg = keySourceProblem('MINT_AUTHORITY_KEYPAIR', 'kms://treasury');
    expect(msg).toMatch(/kms:\/\/ is not a signer/);
  });
});
