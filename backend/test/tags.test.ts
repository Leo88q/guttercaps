// «Свой тег» (docs/16 §3.2–3.3): хранение, автофильтр и модерация.
// Главный инвариант здесь: сохранённый SVG — это не то, что прислал клиент,
// а то, что сервер собрал заново. Тесты ниже проверяют именно это.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { Db } from '../src/db.ts';
import { ServiceError } from '../src/services.ts';
import { TAG_BYTE_LIMIT, TAG_COMMAND_LIMIT, TAG_PER_HOUR, appealTag, getTag, modQueue, myTags, reportTag, sanitizeTagSvg, saveTag, setTagStatus } from '../src/tags.ts';

const kp = () => Keypair.generate().publicKey.toBase58();
const PATH = (stroke = '#FF2E8A', d = 'M10 10L20 20') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512"><path d="${d}" stroke="${stroke}" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const STAMP = (href = '/art/skate/stencil-crown.webp') =>
  `<svg><image href="${href}" x="10" y="10" width="120" height="120" preserveAspectRatio="none"/></svg>`;
const fails = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) { expect((e as ServiceError).code).toBe(code); return; }
  throw new Error(`ожидалась ошибка ${code}`);
};

describe('tags — санитайзер', () => {
  it('пересобирает документ: чужой текст исчезает, путь остаётся', () => {
    const out = sanitizeTagSvg(`<svg><text>Купи крипту</text><path d="M1 1L2 2" stroke="#FFFFFF" stroke-width="4"/></svg>`);
    expect(out.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 512"')).toBe(true);
    expect(out.svg).toContain('<path d="M1 1L2 2"');
    expect(out.svg).not.toContain('text');
    expect(out.commands).toBe(2);
  });

  it('не пропускает скрипты, обработчики и внешние ссылки', () => {
    fails(() => sanitizeTagSvg(`<svg><script>alert(1)</script>${PATH()}</svg>`), 'tag_forbidden');
    fails(() => sanitizeTagSvg(`<svg><path onload="fetch('//evil')" d="M1 1L2 2"/></svg>`), 'tag_forbidden');
    fails(() => sanitizeTagSvg(STAMP('https://evil.example/pixel.png')), 'tag_bad_image');
    fails(() => sanitizeTagSvg(STAMP('/art/skate/../../secret.webp')), 'tag_bad_image');
  });

  it('держит форму в рамках: цвет, толщина, заливка, лимиты', () => {
    fails(() => sanitizeTagSvg(PATH('red')), 'tag_bad_color');
    fails(() => sanitizeTagSvg(PATH('#FF2E8A', 'M10 10Q20 20 30 30')), 'tag_bad_path');
    fails(() => sanitizeTagSvg(`<svg><path d="M1 1L2 2" stroke="#FFFFFF" stroke-width="400" fill="none"/></svg>`), 'tag_bad_width');
    fails(() => sanitizeTagSvg(`<svg><path d="M1 1L2 2" stroke="#FFFFFF" stroke-width="8" fill="#FF0000"/></svg>`), 'tag_bad_fill');
    fails(() => sanitizeTagSvg(''), 'tag_empty');
    fails(() => sanitizeTagSvg('<svg></svg>'), 'tag_empty');
  });

  it('режет по лимиту команд и по весу после пересборки', () => {
    const many = `M0 0` + `L1 1`.repeat(TAG_COMMAND_LIMIT + 5).replace(/L/g, ' L');
    fails(() => sanitizeTagSvg(`<svg><path d="${many}" stroke="#FFFFFF" stroke-width="8"/></svg>`), 'tag_too_many_commands');
    // 400 команд с длинными координатами: по командам проходим, по весу — нет
    const fat = 'M0 0' + Array.from({ length: 399 }, () => ` L1.${'0'.repeat(60)}1 1`).join('');
    fails(() => sanitizeTagSvg(`<svg><path d="${fat}" stroke="#FFFFFF" stroke-width="8"/></svg>`), 'tag_too_large');
    expect(sanitizeTagSvg(PATH()).bytes).toBeLessThan(TAG_BYTE_LIMIT);
  });
});

describe('tags — хранение и видимость', () => {
  it('сохраняет, дедуплицирует и не даёт завалить очередь', () => {
    const db = new Db(':memory:');
    const me = kp();
    const first = saveTag(db, me, PATH());
    expect(first.status).toBe('live');
    expect(first.commands).toBe(2);
    expect(saveTag(db, me, PATH()).id).toBe(first.id); // тот же SVG — та же строка
    expect(myTags(db, me).items).toHaveLength(1);

    for (let i = 1; i < TAG_PER_HOUR; i++) saveTag(db, me, PATH('#FF2E8A', `M${i} ${i}L${i + 5} ${i + 5}`));
    fails(() => saveTag(db, me, PATH('#FF2E8A', 'M900 900L950 950')), 'tag_rate');
  });

  it('у разных кошельков один и тот же тег — разные записи', () => {
    const db = new Db(':memory:');
    const a = saveTag(db, kp(), PATH());
    const b = saveTag(db, kp(), PATH());
    expect(a.id).not.toBe(b.id);
    expect(a.sha256).toBe(b.sha256);
  });

  it('скрытый тег не виден никому, кроме автора', () => {
    const db = new Db(':memory:');
    const author = kp(), stranger = kp();
    const tag = saveTag(db, author, PATH());
    expect(getTag(db, tag.id, stranger).svg).toBeDefined();

    setTagStatus(db, tag.id, 'hidden', 'жалоба');
    expect(getTag(db, tag.id, author).svg).toBeDefined(); // автор всегда видит свой
    expect(getTag(db, tag.id, author).status).toBe('hidden');
    fails(() => getTag(db, tag.id, stranger), 'not_found');
    // для анонимного зрителя скрытого тега не существует вовсе: 404, а не «есть, но не показываем»
    fails(() => getTag(db, tag.id), 'not_found');
  });
});

describe('tags — модерация', () => {
  it('жалоба считается один раз на кошелёк, свой тег пожаловаться нельзя', () => {
    const db = new Db(':memory:');
    const author = kp(), a = kp(), b = kp();
    const tag = saveTag(db, author, PATH());
    expect(reportTag(db, a, tag.id, 'ads').reports).toBe(1);
    fails(() => reportTag(db, a, tag.id, 'ads'), 'already_reported');
    expect(reportTag(db, b, tag.id, 'other').reports).toBe(2);
    fails(() => reportTag(db, author, tag.id, 'other'), 'own_tag');
    fails(() => reportTag(db, a, tag.id, 'because'), 'bad_reason');
  });

  it('очередь модератора ведёт к самым жалобным, а апелляция остаётся за человеком', () => {
    const db = new Db(':memory:');
    const author = kp();
    const quiet = saveTag(db, author, PATH());
    const loud = saveTag(db, author, PATH('#16E5D9', 'M30 30L60 60'));
    reportTag(db, kp(), quiet.id, 'other');
    reportTag(db, kp(), loud.id, 'hate');
    reportTag(db, kp(), loud.id, 'violence');

    const queue = modQueue(db);
    expect(queue.items[0].id).toBe(loud.id);
    expect(queue.items[0].openReports).toBe(2);
    expect(queue.items[1].id).toBe(quiet.id);

    setTagStatus(db, loud.id, 'hidden', 'натасканная надпись');
    expect(getTag(db, loud.id, author).status).toBe('hidden');
    expect(modQueue(db).items.map((t) => t.id)).toEqual([quiet.id]); // скрытый уходит из очереди
    const appealed = appealTag(db, author, loud.id, 'Это название района, а не мат');
    expect(appealed.status).toBe('hidden'); // апелляция не разблокирует сама: решает человек
    fails(() => appealTag(db, author, quiet.id, 'а вдруг'), 'not_hidden');
  });
});
