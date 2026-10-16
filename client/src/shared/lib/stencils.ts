// Каталог трафаретов — одна правда сразу для двух мест: редактор тегов
// штампует ровно эти файлы, а витрина магазина показывает ровно их же.
// Держим список здесь, чтобы «купил — увидел форму в редакторе» не расходилось.
export interface StencilShape {
  /** имя файла в /art/skate без расширения */
  file: string;
  /** индекс района в lore: откуда берётся подпись. null — бесплатная форма */
  district: number | null;
  /** подпись для бесплатных форм (имена фигур не локализованы — это пиктограммы) */
  name: string;
}

export const FREE_STENCILS: StencilShape[] = [
  { file: 'stencil-crown', district: null, name: 'Crown' },
  { file: 'stencil-can', district: null, name: 'Spray can' },
  { file: 'stencil-bolt', district: null, name: 'Bolt' },
  { file: 'stencil-drip', district: null, name: 'Drip' },
  { file: 'stencil-arrow', district: null, name: 'Arrow' },
  { file: 'stencil-star', district: null, name: 'Star' },
  { file: 'stencil-skull', district: null, name: 'Skull' },
  { file: 'stencil-flame', district: null, name: 'Flame' },
  { file: 'stencil-ribbon', district: null, name: 'Ribbon' },
  { file: 'stencil-bubble', district: null, name: 'Bubble tag' },
  { file: 'stencil-cross', district: null, name: 'Cross' },
  { file: 'stencil-dice', district: null, name: 'Dice' },
  { file: 'stencil-frame', district: null, name: 'Frame' },
  { file: 'stencil-burst', district: null, name: 'Burst' },
];

/** Платный пак «Трафареты районов» (docs/16 §3.5): форма района как подпись. */
export const PACK_STENCILS: StencilShape[] = [
  { file: 'stencil-d0-moth', district: 0, name: 'Night Moth' },
  { file: 'stencil-d2-freight', district: 2, name: 'Rail Kings' },
  { file: 'stencil-d4-boombox', district: 4, name: 'Boombox Block' },
  { file: 'stencil-d5-rat', district: 5, name: 'Gutter Beasts' },
  { file: 'stencil-d6-joystick', district: 6, name: 'Pixel Basement' },
];

export const stencilSrc = (file: string) => `/art/skate/${file}.webp`;

/** id сервиса в economy: владение паком — это entitlement kind 12. */
export const STENCIL_PACK_SERVICE_ID = 'districtStencilPack';
