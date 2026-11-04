// Регрессия находки 28: прерванный Phase-G fusion нельзя было продолжить штатным клиентским сценарием.
//
// Поток сжигает три материала ТРЕМЯ отдельными транзакциями, затем платит комиссию и подтверждает.
// Отказ кошелька на втором сжигании, протухший proof или ошибка комиссии оставляли уже сожжённые
// материалы уничтоженными, а id интента и прогресс сжигания нигде не сохранялись: повторный запуск
// создавал новый интент на те же (уже сгоревшие) чипы и падал на первом же сжигании.
//
// Теперь прогресс пишется в хранилище после каждого шага, и следующий запуск (в том числе после
// перезагрузки) досылает недостающее в ТОТ ЖЕ интент: сжигается только несожжённое, комиссия платится
// один раз, а после подтверждения запись снимается.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assetsLeftToBurn, forgetFusionProgress, rememberedFusionProgress, rememberFusionProgress,
  FUSION_PROGRESS_TTL_MS, type FusionProgress, type ProgressStore,
} from './phaseGFusion';

const root = path.resolve(process.cwd(), process.cwd().endsWith('/client') ? '..' : '.');
const src = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const memStore = (): ProgressStore & { mem: Map<string, string> } => {
  const mem = new Map<string, string>();
  return { mem, getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); }, removeItem: (k) => { mem.delete(k); } };
};

const A = 'AssetA1111111111111111111111111111111111111';
const B = 'AssetB1111111111111111111111111111111111111';
const C = 'AssetC1111111111111111111111111111111111111';
const W = 'Wallet111111111111111111111111111111111111';

const rec = (over: Partial<FusionProgress> = {}): FusionProgress => ({
  fusionId: 12, assets: [A, B, C], burned: [], paySig: null, burnSig: null, createdAt: 1_000_000, wallet: W, ...over,
});

describe('находка 28: прогресс fusion переживает отказ', () => {
  it('запись читается обратно и знает, что ещё не сожжено', () => {
    const store = memStore();
    expect(rememberedFusionProgress(store, 1_000_000)).toBeNull();
    rememberFusionProgress(store, rec({ burned: [A, B], burnSig: 'BURNSIG' }));
    const back = rememberedFusionProgress(store, 1_000_000)!;
    expect(back.fusionId).toBe(12);
    expect(assetsLeftToBurn(back)).toEqual([C]); // повторно A и B не сжигаются
    expect(back.burnSig).toBe('BURNSIG');
    forgetFusionProgress(store);
    expect(rememberedFusionProgress(store, 1_000_000)).toBeNull();
    // среда без хранилища не ломает флоу
    expect(() => rememberFusionProgress(null, rec())).not.toThrow();
    expect(rememberedFusionProgress(null, 1_000_000)).toBeNull();
  });

  it('испорченная, чужая или просроченная запись не запускает восстановление', () => {
    const bad: unknown[] = [
      'not json', '{}', 'null', '[]',
      JSON.stringify(rec({ fusionId: 0 })),
      JSON.stringify(rec({ assets: [A, B] })),            // не трио
      JSON.stringify(rec({ assets: [A, A, B] })),         // дубликаты
      JSON.stringify(rec({ burned: ['unknown-asset'] })), // сожжено то, чего нет в наборе
      JSON.stringify(rec({ paySig: 5 as unknown as string })),
      JSON.stringify(rec({ wallet: '' })),
    ];
    for (const raw of bad) {
      const store = memStore();
      store.setItem('gc:pendingFusion', raw as string);
      expect(rememberedFusionProgress(store, 1_000_000), String(raw)).toBeNull();
    }
    // TTL: интент на бэкенде живёт сутки, позже досылать нельзя (материалы уже никому не обещаны)
    const store = memStore();
    rememberFusionProgress(store, rec());
    expect(rememberedFusionProgress(store, 1_000_000 + FUSION_PROGRESS_TTL_MS - 1)).not.toBeNull();
    expect(rememberedFusionProgress(store, 1_000_000 + FUSION_PROGRESS_TTL_MS + 1)).toBeNull();
  });

  it('проводка на месте: запись до первого сжигания, только несожжённое, одна оплата, снятие после подтверждения', () => {
    const flow = src('client/src/features/fusion/phaseGFusion.ts');
    const intentAt = flow.indexOf(`api.post('/fusion/order', { assets: args.assets })`);
    const rememberAt = flow.indexOf('rememberFusionProgress(store, progress);');
    const burnAt = flow.indexOf('for (const asset of assetsLeftToBurn(');
    expect(intentAt).toBeGreaterThan(0);
    expect(rememberAt).toBeGreaterThan(intentAt); // id сохранён сразу после создания интента
    expect(burnAt).toBeGreaterThan(rememberAt);
    // прогресс пишется после каждого сжигания, а не в конце
    expect(flow).toContain('progress = { ...progress, burned: [...burnt], burnSig };');
    // комиссия платится один раз: у оплаченного интента второй подписи нет
    expect(flow).toContain('if (!progress?.paySig) {');
    // после подтверждения запись снимается, иначе модалка досылала бы завершённый fusion
    expect(flow).toContain('forgetFusionProgress(store);');
    // восстановление чужого интента чужим кошельком невозможно
    expect(flow).toContain(`if (args.signer && args.signer.publicKey.toBase58() !== saved.wallet) return null;`);
    // страница сама подхватывает незавершённый fusion (материалы уже сгорели — выбрать их нельзя)
    const page = src('client/src/features/fusion/Fusion.tsx');
    expect(page).toContain('resumePhaseGFusion({ connection, signer: wallet })');
    expect(page).toContain('resumedRef.done');
  });
});
