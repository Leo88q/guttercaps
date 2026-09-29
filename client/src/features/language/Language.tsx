// Language tab — a first-class screen (not buried in settings) because the
// user base is EN/PT/ES/VI/ID/FIL/RU and many Seeker devices ship with a
// system locale that is not the player's reading language. Each option is rendered in its own language
// so a player can always find their way home.
import { useState } from 'react';
import { LOCALES, LOCALE_META, useLocale, useT, type Locale } from '@/shared/i18n';
import { useUiStore } from '@/app/store/ui';
import { detectLocale } from '@/shared/i18n';

/** Spray-tag tile instead of a flag emoji: the locale code hand-tagged on a
 *  sticker. Flags rendered as emoji varied per platform and broke the palette;
 *  the tag keeps the street voice and reads at 22px. */
function LangTag({ code }: { code: string }) {
  return (
    <svg width={38} height={27} viewBox="0 0 38 27" className="lang-tag" aria-hidden>
      <rect x="2" y="2" width="34" height="23" rx="6" className="lang-tag-face" />
      <path d="M5 22 C12 16 26 9 33 5" className="lang-tag-spray" />
      <text x="19" y="18.5" textAnchor="middle" className="lang-tag-code">{code.toUpperCase()}</text>
    </svg>
  );
}

export default function Language() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const toast = useUiStore((s) => s.toast);
  const [busy, setBusy] = useState<Locale | null>(null);
  const detected = detectLocale();

  async function pick(l: Locale) {
    if (l === locale && useUiStore.getState().localeExplicit) return;
    setBusy(l);
    try {
      await setLocale(l);
      // toast in the *new* language — read straight from the loaded bundle
      toast({ kind: 'success', title: LOCALE_META[l].native, body: undefined });
    } catch {
      toast({ kind: 'error', title: { key: 'errors.network' } });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page stack page-bg page-bg-language">
      <div>
        <h1 className="page-title">{t('lang.title')}</h1>
        <p className="page-sub">{t('ui.languageHint')}</p>
      </div>

      <div className="lang-grid" role="radiogroup" aria-label={t('lang.title')}>
        {LOCALES.map((l) => {
          const m = LOCALE_META[l];
          const active = l === locale;
          return (
            <button
              key={l}
              role="radio"
              aria-checked={active}
              lang={m.tag}
              className={`lang-card${active ? ' active' : ''}`}
              disabled={busy !== null}
              onClick={() => void pick(l)}
            >
              <LangTag code={m.code} />
              <span className="lang-native">{m.native}</span>
              <span className="lang-english mono">{new Intl.DisplayNames([LOCALE_META[locale].tag], { type: 'language' }).of(m.tag) ?? m.native}{l === detected ? ` · ${t('lang.auto', { name: m.native })}` : ''}</span>
              {busy === l && <span className="lang-spinner" aria-hidden />}
            </button>
          );
        })}
      </div>

      <div className="tiny muted">{t('lang.current', { name: LOCALE_META[locale].native })}</div>
    </div>
  );
}
