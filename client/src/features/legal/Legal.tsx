// /legal/:doc — canonical documents plus six locally bundled convenience translations.
//
// No API data fetching, wallet or query client. Only local translation chunks are loaded. A legal page that needs an RPC
// to render is a legal page that fails in the exact regions where someone most needs to read it, and it
// is the page a regulator, a store reviewer and a journalist open first.
import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { legalDoc, LEGAL_IDS, LEGAL_EFFECTIVE, RESTRICTED_REGIONS, type LegalDoc, type LegalCopy } from '@/shared/lib/legal';
import { useT, useLocale, fmtLocale, type Locale } from '@/shared/i18n';
import { loadLegalCopy } from '@/shared/lib/legalCopy';
import { APP_NAME, FLAGS } from '@/app/config';

export default function Legal() {
  const { doc } = useParams();
  // `/legal` with no document is the URL a footer link or a store listing ends up with after a typo in
  // the path, and /terms + /privacy are aliases for the same reason: neither should 404.
  if (!doc) return <Navigate to="/legal/terms" replace />;
  const d = legalDoc(doc);
  return d ? <Document doc={d} /> : <Unknown />;
}

function Document({ doc }: { doc: LegalDoc }) {
  const t = useT();
  const { locale, meta, setLocale } = useLocale();
  const [copy, setCopy] = useState<{ locale: Locale; docs?: LegalCopy; failed?: boolean }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (locale === 'en') return;
    let current = true;
    setCopy({ locale });
    loadLegalCopy(locale).then(
      docs => { if (current) setCopy({ locale, docs }); },
      () => { if (current) setCopy({ locale, failed: true }); },
    );
    return () => { current = false; };
  }, [locale, attempt]);
  // Never show a stale async response or label English paragraphs as the selected language.
  const localized = locale === 'en' ? doc : copy?.locale === locale ? copy.docs?.[doc.slug] : undefined;
  const failed = copy?.locale === locale && copy.failed;

  const title = t(doc.slug === 'terms' ? 'legal.terms' : 'legal.privacy');
  useEffect(() => { document.title = `${title} · ${APP_NAME}`; }, [title]);

  return (
    <div className="page stack" style={{ maxWidth: 760, minWidth: 0, overflowWrap: 'anywhere' }}>
      <nav className="row" style={{ gap: 12, flexWrap: 'wrap' }} aria-label={t('legal.title')}>
        <Link to="/account/rights">{t('rights.title')}</Link>
        {LEGAL_IDS.map((id) => (
          <Link key={id} to={`/legal/${id}`} aria-current={id === doc.slug ? 'page' : undefined} className={id === doc.slug ? 'active' : ''}>
            {t(id === 'terms' ? 'legal.terms' : 'legal.privacy')}
          </Link>
        ))}
      </nav>

      <h1 className="page-title">{title}</h1>
      <p className="muted small">{t('legal.updated', { date: fmtLocale.date(LEGAL_EFFECTIVE, locale, { dateStyle: 'medium', timeZone: 'UTC' }) })} · {meta.native}</p>

      {locale !== 'en' && (
        <button type="button" className="btn" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }} onClick={() => void setLocale('en')}>
          {t('ui.englishDocument')}
        </button>
      )}
      {localized ? (
        <article className="stack legal-body" lang={meta.tag} aria-label={title}>
          <p>{localized.intro}</p>
          {localized.sections.map((s, index) => (
            <section key={index} className="card stack" style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 18, margin: 0 }}>{s.h}</h2>
              {s.p.map((paragraph, i) => <p key={i} style={{ margin: 0 }}>{paragraph}</p>)}
            </section>
          ))}
        </article>
      ) : failed ? (
        <div role="alert" className="card stack">
          <p>{t('errors.network')}</p>
          <button type="button" className="btn" onClick={() => setAttempt(n => n + 1)}>{t('common.retry')}</button>
        </div>
      ) : <p role="status">{t('common.loading')}</p>}

      <div className="card stack muted small">
        <p style={{ margin: 0 }}>{t('legal.canonical')}</p>
        <p style={{ margin: 0 }}>
          {t('legal.ages')}{FLAGS.geoGate && <> · {t('legal.noSaleIn')} {RESTRICTED_REGIONS.join(', ')}</>} · <Link to="/verify">{t('legal.verify')}</Link>
        </p>
      </div>
    </div>
  );
}

function Unknown() {
  const t = useT();
  return (
    <div className="page stack" style={{ maxWidth: 560 }}>
      <h1 className="page-title">404</h1>
      <p className="page-sub">{t('legal.notFound')}</p>
      <p>{LEGAL_IDS.map((id) => <Link key={id} to={`/legal/${id}`} style={{ marginRight: 12 }}>{t(id === 'terms' ? 'legal.terms' : 'legal.privacy')}</Link>)}</p>
    </div>
  );
}
