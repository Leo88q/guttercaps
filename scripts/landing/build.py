#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Builds ../../guttercaps-landing.html.

  python3 scripts/landing/build.py          # write the landing
  node --experimental-strip-types scripts/landing/check.ts # verify numbers vs packages/economy

Inputs: content.py + locales/*.json (seven-language copy + tables), base.css (visual system of the
original landing, kept verbatim), collections.js (8 districts × 9 caps).
The page is a single self-contained HTML file: no build step at deploy time.
"""
import json, html, pathlib, base64
from urllib.parse import quote
from content import T, HOWTO, PACKS, FAQ, TIERS, SITE, TITLE, DESC
from i18n import LOCALES, TAGS, NAMES, load_translations

TRANSLATIONS = load_translations(T)

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / 'guttercaps-landing.html'

# ---------------------------------------------------------------------- fonts
# SEC-B4 (SECURITY-AUDIT-2026-09-26.md): the landing used to load its webfonts from fonts.googleapis.com.
# That was the page's only third-party request, it carried every visitor's IP (while /legal/privacy
# promises no third-party analytics), and the app's own CSP (`font-src 'self' data:`, ops/deploy/nginx.conf)
# blocked the same URL in production anyway. The fonts are now vendored in the repo
# (client/public/fonts, see scripts/vendor-fonts.ts for the OFL sources) and inlined here as data URIs —
# which keeps the "deploy = copy one HTML file" promise of this landing intact.
# The manifest is the single source of truth: the files whose `surfaces` include "landing" are exactly the
# subsets this seven-language page needs, including Vietnamese and extended Latin.
FONT_DIR = ROOT / 'client' / 'public' / 'fonts'
FONT_MANIFEST = json.loads((FONT_DIR / 'manifest.json').read_text())

def fonts_css() -> str:
    """`@font-face` rules with the woff2 bytes inlined as base64 data URIs."""
    out = []
    for f in FONT_MANIFEST['files']:
        if 'landing' not in f['surfaces']:
            continue
        data = base64.b64encode((FONT_DIR / f['file']).read_bytes()).decode('ascii')
        out.append(
            "@font-face{font-family:'%s';font-style:normal;font-display:swap;font-weight:%d;"
            "src:url(data:font/woff2;base64,%s) format('woff2');unicode-range:%s}"
            % (f['family'], f['weight'], data, f['unicodeRange'])
        )
    return '\n'.join(out)

FONTS_CSS = fonts_css()
OLD_CSS = (HERE / 'base.css').read_text()
COLLECTIONS_JS = (HERE / 'collections.js').read_text()
# Reuse the game's shared presentation catalogs; canonical mint metadata stays English.
def client_catalog(folder, locale):
    source = (ROOT / 'client/src/shared/i18n' / folder / (locale + '.ts')).read_text()
    payload = source.split('const ' + ('ui' if folder == 'ui' else 'catalog') + ' = ', 1)[1]
    return json.JSONDecoder().raw_decode(payload)[0]

LANDING_CATALOG = {l: client_catalog('catalog', l) for l in LOCALES}
LANDING_UI = {l: {k: v for k, v in client_catalog('ui', l).items() if k.startswith(('pack', 'rarity')) or k in ('comingSoon', 'primaryNav')} for l in LOCALES}


# Embedded imagery: AI street-art backdrops (bg-*), per-district contact
# sheets cut from the real chip masters (district-*), and the four foil
# wrapper renders (starter/standard/premium/limited — see PACK_ART_STEMS).
# Everything is inlined as webp data URIs so the landing stays one
# self-contained file — the tradeoff is roughly +2 MB of HTML, tracked in
# scripts/landing/README.
# Tile grid of the district contact sheets — MUST match the sheet generator
# (TILE x TILE tiles, GUT gutter, PAD padding; see scripts/landing/README.md).
# app.js uses it to sprite each chip's real art out of its district sheet.
# The visual refresh uses 3×3 sheets made from the 256px game exports.
# Keep these numbers in sync with the sheet generator; app.js uses them to
# crop the individual cap sprites without shipping 72 duplicate images.
ART_TILE, ART_GUT, ART_PAD = 256, 12, 16
ASSET_DIR = HERE / 'assets'
PHOTOS, DISTRICT_ART, STEP_ART, GEN_ICONS, PACK_ART = {}, {}, {}, {}, {}
PACK_ART_STEMS = {'starter', 'standard', 'premium', 'limited', 'chest'}  # foil wrappers + founders chest, scripts/landing/README
if ASSET_DIR.is_dir():
    for _p in sorted(ASSET_DIR.glob('*.webp')):
        _uri = 'data:image/webp;base64,' + base64.b64encode(_p.read_bytes()).decode()
        if _p.stem.startswith('district-'):
            DISTRICT_ART[_p.stem.split('-', 1)[1]] = _uri
        elif _p.stem.startswith('step-'):
            STEP_ART[_p.stem] = _uri
        elif _p.stem.startswith('icon-'):
            GEN_ICONS[_p.stem] = _uri
        elif _p.stem in PACK_ART_STEMS:
            PACK_ART[_p.stem] = _uri  # exposed to app.js as PACK_ART, NOT as wall photos
        else:
            PHOTOS[_p.stem] = _uri
if any(k not in PACK_ART for k in PACK_ART_STEMS):
    raise SystemExit('landing assets missing pack art: ' + ', '.join(sorted(PACK_ART_STEMS - PACK_ART.keys())))


def photo_style():
    rules = '\n'.join(f'  .wall-photo[data-photo="{k}"] {{ background-image: url({v}); }}'
                      for k, v in PHOTOS.items())
    return f'<style id="wall-photos">\n{rules}\n</style>'


def t(k):
    return T[k][0]


SOFT_COLORS = {
    'var(--cyan)': 'var(--cyan-soft)',
    'var(--magenta)': 'var(--magenta-soft)',
    'var(--acid)': 'var(--acid-soft)',
    'var(--orange)': 'var(--orange-soft)',
    'var(--trust)': 'var(--trust-soft)',
}


def head_block(k_h, k_p, color):
    color = SOFT_COLORS.get(color, color)
    return f'''    <div class="section-head">
      <h2 class="tag-heading" style="--tag-color: {color};" data-i18n-html="{k_h}">{t(k_h)}</h2>
      <p data-i18n="{k_p}">{t(k_p)}</p>
    </div>'''


NEW_CSS = (HERE / 'extra.css').read_text()


def donut_svg():
    parts = [(55, '#16E5D9'), (15, '#FF2E8A'), (15, '#FF7A1A'), (10, '#2E8BFF'), (5, '#B6FF3C')]
    r, cx, cy, sw = 62, 85, 85, 26
    circ = 2 * 3.141592653589793 * r
    out, off = [], 0.0
    for pct, color in parts:
        dash = circ * pct / 100
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{color}" stroke-width="{sw}" '
                   f'stroke-dasharray="{dash:.2f} {circ - dash:.2f}" stroke-dashoffset="{-off:.2f}" transform="rotate(-90 {cx} {cy})"/>')
        off += dash
    return ('<svg viewBox="0 0 170 170" role="img" data-i18n-aria="allocation.label" aria-label="$CG allocation: 55% play, 15% ecosystem, 15% team, 10% treasury, 5% airdrops">'
            + ''.join(out)
            + '<text x="85" y="80" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="15" font-weight="700" fill="#D8D8DC" data-i18n="allocation.billion">1 billion</text>'
            + '<text x="85" y="98" text-anchor="middle" font-family="Inter, sans-serif" font-size="10" fill="rgba(216,216,220,0.6)" data-i18n="allocation.cap">hard cap</text></svg>')


# -------------------------------------------------------------------- channels
# The community channels are ONE list, and it is this one. The same five networks used to be
# written out three times with nothing comparing them: the (key, label) tuple inside
# `community_links`, the ICON map keyed by those same five names, and the `LINKS` object in
# app.js that the `data-link` resolver reads at runtime. Nothing broke when they agreed, and
# nothing caught it when they did not — add a channel to the tuple and forget app.js, and the
# anchor still ships: `LINKS[key]` is undefined, so app.js leaves `href="#"` and paints the
# "coming soon" treatment over a link that was supposed to be live. Order, label, icon and URL
# therefore travel together here, and the `LINKS` half of app.js is generated from this list
# (the `/*__CHANNELS__*/` placeholder) — a channel cannot be rendered without a URL slot.
#
# `url` stays '#' until we own the handle; app.js turns that into a visibly disabled link
# rather than a link to nothing. To go live: put the URL here and rebuild. Add a channel by
# appending one record — there is no second list left to keep in step.
#
# `i18n` is optional and only set where the visible label is a translated word rather than a
# proper noun (Telegram / X / Discord / GitHub are brand names and are never translated).
CHANNELS = [
  {'key': 'telegram', 'label': 'Telegram', 'url': '#',
   'icon': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.6 15.5l-.4 5c.6 0 .8-.3 1.1-.6l2.7-2.5 5.5 4c1 .6 1.7.3 2-.9l3.6-17c.3-1.5-.6-2.1-1.6-1.7L1.4 9.9C0 10.5 0 11.3 1.2 11.6l5.4 1.7L19.2 5.4c.6-.4 1.1-.2.7.2z"/></svg>'},
  {'key': 'x', 'label': 'X', 'url': '#',
   'icon': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.2 2h3.4l-7.4 8.5L23 22h-6.8l-5.3-7-6.1 7H1.4l7.9-9.1L1 2h7l4.8 6.4L18.2 2zm-1.2 18h1.9L7.1 3.9H5.1L17 20z"/></svg>'},
  {'key': 'discord', 'label': 'Discord', 'url': '#',
   'icon': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.5 5.3A17 17 0 0 0 15.3 4l-.5 1a16 16 0 0 0-5.6 0l-.5-1a17 17 0 0 0-4.2 1.3C1.8 9.3 1.1 13.2 1.5 17a17 17 0 0 0 5.2 2.6l1.1-1.8a11 11 0 0 1-1.8-.9l.4-.3a12 12 0 0 0 11.2 0l.4.3-1.8.9 1.1 1.8a17 17 0 0 0 5.2-2.6c.5-4.4-.8-8.3-3-11.7zM8.7 14.6c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.9 2.1-1.9 2.1zm6.6 0c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1z"/></svg>'},
  {'key': 'docs', 'label': 'Docs', 'i18n': 'community.docs', 'url': '#',
   'icon': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 3h9l5 5v13H6z"/><path d="M15 3v5h5M9 13h6M9 17h6"/></svg>'},
  {'key': 'github', 'label': 'GitHub', 'url': '#',
   'icon': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5A12 12 0 0 0 8.2 23.9c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z"/></svg>'},
]

# The `LINKS` entries app.js needs for the above, as one object literal fragment. Generated, not
# hand-written, so the two halves cannot drift; app.js splices this into its `LINKS` object.
CHANNELS_LINKS_JS = ',\n'.join(f'    {c["key"]}: {json.dumps(c["url"])}' for c in CHANNELS)

LOGO_SVG = ('<svg class="sig-tag" width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">'
            '<path d="M16 3 C22 12 25 16 25 20 A9 9 0 0 1 7 20 C7 16 10 12 16 3 Z" fill="var(--magenta)" opacity="0.6"/>'
            '<circle cx="16" cy="20" r="5.5" fill="var(--cyan)"/></svg>')

# Browser tab icons, inlined so the "deploy = one file" promise holds. The hand-drawn SVG circle
# that used to live here is unsupported by Safari (no SVG favicons in tabs) and nearly invisible
# on dark tab bars anyway (a dark disc with a hairline ring). The real set ships with the client
# (client/public): the SVG covers Chrome/Firefox/Edge, the PNG 16/32 fallbacks cover Safari.
CLIENT_PUBLIC = ROOT / 'client' / 'public'
FAVICON = 'data:image/svg+xml,' + quote((CLIENT_PUBLIC / 'favicon.svg').read_text())
FAVICON_PNG_16 = 'data:image/png;base64,' + base64.b64encode((CLIENT_PUBLIC / 'favicon-16.png').read_bytes()).decode()
FAVICON_PNG_32 = 'data:image/png;base64,' + base64.b64encode((CLIENT_PUBLIC / 'favicon-32.png').read_bytes()).decode()


def faq_html():
    rows = []
    for i, (q, a, _qr, _ar) in enumerate(FAQ):
        rows.append(f'      <details{" open" if i == 0 else ""}><summary data-i18n="faq.q{i}">{html.escape(q)}</summary>'
                    f'<p data-i18n="faq.a{i}">{html.escape(a)}</p></details>')
    return '\n'.join(rows)


def jsonld_game():
    return json.dumps({
        '@context': 'https://schema.org', '@type': 'VideoGame', 'name': 'GUTTERCAPS', 'url': SITE + '/',
        'description': DESC[0], 'genre': ['Collectible card game', 'Strategy'],
        'gamePlatform': ['Web', 'Android (Solana dApp Store)'], 'applicationCategory': 'Game', 'operatingSystem': 'Any',
        'inLanguage': ['en', 'pt-BR', 'es', 'vi', 'id', 'fil', 'ru'], 'contentRating': '18+',
        'offers': {'@type': 'AggregateOffer', 'priceCurrency': 'USD', 'lowPrice': '1.99', 'highPrice': '29.99', 'offerCount': 4},
        'publisher': {'@type': 'Organization', 'name': 'GUTTERCAPS', 'url': SITE + '/'},
    }, ensure_ascii=False, indent=1)


def jsonld_faq():
    return json.dumps({
        '@context': 'https://schema.org', '@type': 'FAQPage',
        'mainEntity': [{'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a, _, _ in FAQ],
    }, ensure_ascii=False, indent=1)


def mech_card(n, fallback_icon=''):
    icon = GEN_ICONS.get(f'icon-mech-{n}')
    if icon:
        icon = f'<img src="{icon}" width="64" height="64" alt="" loading="lazy" decoding="async">'
    else:
        icon = fallback_icon
    return f'''      <div class="mech-card">
        <span class="mech-icon" aria-hidden="true">{icon}</span>
        <h3 data-i18n="mech.{n}h">{t(f"mech.{n}h")}</h3>
        <p data-i18n="mech.{n}p">{t(f"mech.{n}p")}</p>
        <span class="mech-fact" data-i18n="mech.{n}f">{t(f"mech.{n}f")}</span>
        <span class="mech-badge" data-i18n="mech.badge">{t("mech.badge")}</span>
      </div>'''


def layer(n, color, status_key):
    color = SOFT_COLORS.get(color, color)
    items = ''.join(f'<li data-i18n="road.{n}{c}">{t(f"road.{n}{c}")}</li>' for c in 'abcdef' if f'road.{n}{c}' in T)
    return f'''      <div class="layer">
        <div>
          <div class="layer-tag" style="--layer-color: {color};">Layer {n}</div>
          <div class="layer-status" data-i18n="{status_key}">{t(status_key)}</div>
        </div>
        <div class="layer-body">
          <h3 data-i18n-html="road.{n}h">{t(f"road.{n}h")}</h3>
          <p data-i18n="road.{n}p">{t(f"road.{n}p")}</p>
          <ul>{items}</ul>
        </div>
      </div>'''


def bar(key, pct, color):
    return (f'          <div class="bar"><span data-i18n="{key}">{t(key)}</span><div class="track">'
            f'<div class="fill" style="width:{pct}%;--bar-color:{color}"></div></div><b>{pct} %</b></div>')


def fee_row(k, rate):
    return f'            <tr><td data-i18n="{k}">{t(k)}</td><td class="num">{rate}</td><td data-i18n="{k}w">{t(k + "w")}</td></tr>'


def community_links(with_icons):
    out = []
    for c in CHANNELS:
        icon = c['icon'] if with_icons else ''
        label = f'<span data-i18n="{c["i18n"]}">{t(c["i18n"])}</span>' if 'i18n' in c else c['label']
        out.append(f'      <a data-link="{c["key"]}" href="#" rel="noopener" target="_blank">{icon}{label}</a>')
    return '\n'.join(out)


HEAD = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{TITLE[0]}</title>
<meta name="description" content="{DESC[0]}" />
<meta name="robots" content="index,follow,max-image-preview:large" />
<meta name="theme-color" content="#16151A" />
<link rel="canonical" href="{SITE}/" />
<link rel="alternate" hreflang="en" href="{SITE}/?lang=en" />
<link rel="alternate" hreflang="ru" href="{SITE}/?lang=ru" />
<link rel="alternate" hreflang="x-default" href="{SITE}/" />
<link rel="icon" type="image/svg+xml" href="{FAVICON}" />
<link rel="icon" type="image/png" sizes="16x16" href="{FAVICON_PNG_16}" />
<link rel="icon" type="image/png" sizes="32x32" href="{FAVICON_PNG_32}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="GUTTERCAPS" />
<meta property="og:title" content="{TITLE[0]}" />
<meta property="og:description" content="{DESC[0]}" />
<meta property="og:url" content="{SITE}/" />
<meta property="og:image" content="{SITE}/assets/og-guttercaps.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="GUTTERCAPS — chrome bottle cap on a wet graffiti wall, Solana collectible game" />
<meta property="og:locale" content="en_US" />
<meta property="og:locale:alternate" content="ru_RU" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="{TITLE[0]}" />
<meta name="twitter:description" content="{DESC[0]}" />
<meta name="twitter:image" content="{SITE}/assets/og-guttercaps.png" />
<!-- SEC-B4 (SECURITY-AUDIT-2026-09-26.md): the landing is served by a static host whose response
     headers we do not control, so the only policy we can ship with the page is a meta tag. It blocks
     everything and names what the page really needs — including its own inline styles and the one
     endpoint the live counters read. There is no third-party origin left: the webfonts are inlined
     below (vendored under client/public/fonts, OFL — see scripts/vendor-fonts.ts), which is also why
     there is no `preconnect` and no `referrerpolicy` dance for a font CDN. `frame-ancestors`/HSTS
     cannot be set from here (meta CSP ignores frame-ancestors by spec): the host has to add those
     headers — ops/deploy/nginx.conf is the SPA's copy of the same policy.
     `referrer` is a separate tag: `no-referrer` so the one remaining request (the stats call) and any
     outbound click carry no path/query of the page the visitor came from. -->
<meta name="referrer" content="no-referrer" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' https://api.guttercaps.gg; media-src 'self'; manifest-src 'self'" />
<style>
{FONTS_CSS}
</style>
<script type="application/ld+json">
{jsonld_game()}
</script>
<script type="application/ld+json">
{jsonld_faq()}
</script>
{photo_style()}
<noscript><style>.wall-photo {{ opacity: var(--photo-op, 0.75); }}</style></noscript>
<style>
{OLD_CSS.rstrip()}
{NEW_CSS.rstrip()}
</style>
</head>'''

BODY = f'''
<body>
<a class="skip" href="#main" data-i18n="skip">{t('skip')}</a>

<nav aria-label="Primary">
  <a class="logo-mark" href="#top">{LOGO_SVG}GUTTER<span>CAPS</span></a>
  <div class="nav-links">
    <a href="#why" data-i18n="nav.why">{t('nav.why')}</a>
    <a href="#how" data-i18n="nav.how">{t('nav.how')}</a>
    <a href="#packs" data-i18n="nav.packs">{t('nav.packs')}</a>
    <a href="#rarity" data-i18n="nav.rarity">{t('nav.rarity')}</a>
    <a href="#world" data-i18n="nav.world">{t('nav.world')}</a>
    <a href="#economy" data-i18n="nav.economy">{t('nav.economy')}</a>
    <a href="#road" data-i18n="nav.roadmap">{t('nav.roadmap')}</a>
    <a href="#faq" data-i18n="nav.faq">{t('nav.faq')}</a>
    <a href="#collections" data-i18n="nav.districts">{t('nav.districts')}</a>
  </div>
  <div class="nav-right">
    <div class="lang-toggle" role="group" aria-label="Language">
      {''.join(f'<button type="button" data-lang="{l}" aria-pressed="{str(l == "en").lower()}" aria-label="{NAMES[l]}" title="{NAMES[l]}" lang="{TAGS[l]}">{l.upper()}</button>' for l in LOCALES)}
    </div>
    <a class="btn-spray" data-link="app" href="#" onclick="fireSpray(this)"><span class="mist-puff"></span><span data-i18n="nav.open">{t('nav.open')}</span></a>
  </div>
</nav>

<main id="main">
<!-- ================= HERO ================= -->
<section class="hero brick wall-hero" id="top">
  <div class="wall-photo" data-photo="bg-hero"></div>
  <div class="lamp-glow lamp-tl" style="background: radial-gradient(circle, rgba(255,46,138,0.28), transparent 70%);"></div>
  <div class="lamp-glow lamp-tr" style="background: radial-gradient(circle, rgba(22,229,217,0.24), transparent 70%);"></div>
  <p class="eyebrow" data-i18n="hero.eyebrow">{t('hero.eyebrow')}</p>
  <h1 class="hero-title" id="hero-title" aria-label="GUTTERCAPS"></h1>
  <p class="hero-sub" data-i18n="hero.sub">{t('hero.sub')}</p>
  <div class="hero-pillars">
    <span class="pillar-chip" data-i18n="hero.p1">{t('hero.p1')}</span>
    <span class="pillar-chip" data-i18n="hero.p2">{t('hero.p2')}</span>
    <span class="pillar-chip" data-i18n="hero.p3">{t('hero.p3')}</span>
    <span class="pillar-chip" data-i18n="hero.p4">{t('hero.p4')}</span>
    <span class="pillar-chip" data-i18n="hero.p5">{t('hero.p5')}</span>
  </div>
  <div class="hero-cta-row">
    <a class="btn-spray btn-spray-lg" data-link="app" href="#" onclick="fireSpray(this)"><span class="mist-puff"></span><span data-i18n="hero.cta">{t('hero.cta')}</span></a>
    <a class="btn-ghost" href="#packs" data-i18n="hero.cta2">{t('hero.cta2')}</a>
  </div>
  <p class="hero-note" data-i18n="hero.note">{t('hero.note')}</p>
  <div class="skate-rail"></div>
</section>

<!-- ================= WHY: THE LOOP AND ITS VALUE (2026-10 reorg: right after the hero) ================= -->
<section class="section brick wall-value torn-top" id="why">
  <div class="wall-photo" data-photo="bg-value"></div>
  <div class="lamp-glow" style="top:-190px; left:10%; background: radial-gradient(circle, rgba(22,229,217,0.22), transparent 70%);"></div>
  <div class="wrap">
{head_block('why.h', 'why.p', 'var(--cyan)')}
    <ol class="why-loop">
      {''.join(f'<li data-i18n="why.l{i}">{t(f"why.l{i}")}</li>' for i in range(1, 5))}
    </ol>
    <div class="why-grid">
      {''.join(f'<div class="why-card clean-zone"><h3 data-i18n="why.v{i}h">{t(f"why.v{i}h")}</h3><p data-i18n="why.v{i}p">{t(f"why.v{i}p")}</p></div>' for i in range(1, 5))}
    </div>
  </div>
</section>

<!-- ================= PRE-SALE (docs/preorder-beta.md) ================= -->
<section class="section brick wall-value torn-top" id="presale">
  <div class="wall-photo" data-photo="bg-packs"></div>
  <div class="lamp-glow" style="top:-180px; left:12%; background: radial-gradient(circle, rgba(255,122,26,0.20), transparent 70%);"></div>
  <div class="wrap">
{head_block('presale.h', 'presale.p', 'var(--orange)')}
    <div class="presale-offers">
      <article class="presale-offer">
        <img class="presale-offer-art" data-pack-art="limited" alt="" width="640" height="640" loading="lazy" decoding="async">
        <div class="presale-offer-name" data-i18n="presale.o1h">{t('presale.o1h')}</div>
        <div class="presale-offer-price">0.30 SOL</div>
        <p data-i18n="presale.o1p">{t('presale.o1p')}</p>
      </article>
      <article class="presale-offer">
        <div class="presale-chest">
          <img class="presale-offer-art" data-pack-art="chest" alt="" width="640" height="640" loading="lazy" decoding="async">
        </div>
        <div class="presale-offer-name" data-i18n="presale.o2h">{t('presale.o2h')}</div>
        <div class="presale-offer-price">0.999 SOL</div>
        <p data-i18n="presale.o2p">{t('presale.o2p')}</p>
      </article>
    </div>
    <div class="presale-grid">
      <div class="presale-card clean-zone"><h3 data-i18n="presale.c1h">{t('presale.c1h')}</h3><p data-i18n="presale.c1p">{t('presale.c1p')}</p></div>
      <div class="presale-card clean-zone"><h3 data-i18n="presale.c2h">{t('presale.c2h')}</h3><p data-i18n="presale.c2p">{t('presale.c2p')}</p></div>
      <div class="presale-card clean-zone"><h3 data-i18n="presale.c3h">{t('presale.c3h')}</h3><p data-i18n="presale.c3p">{t('presale.c3p')}</p></div>
      <div class="presale-card clean-zone"><h3 data-i18n="presale.c4h">{t('presale.c4h')}</h3><p data-i18n="presale.c4p">{t('presale.c4p')}</p></div>
    </div>
    <div class="presale-cta">
      <a class="btn-spray btn-spray-lg" data-link="presale" href="#" onclick="fireSpray(this)"><span class="mist-puff"></span><span data-i18n="presale.cta">{t('presale.cta')}</span></a>
    </div>
    <p class="presale-note" data-i18n="presale.note">{t('presale.note')}</p>
  </div>
</section>

<!-- ================= HOW TO PLAY ================= -->
<section class="section brick wall-mech torn-top" id="how">
  <div class="wall-photo" data-photo="bg-how"></div>
  <div class="lamp-glow" style="top:-200px; right:10%; background: radial-gradient(circle, rgba(255,46,138,0.22), transparent 70%);"></div>
  <div class="wrap">
{head_block('how.h', 'how.p', 'var(--magenta-soft)')}
    <ol class="howto" id="howto"></ol>
  </div>
</section>

<!-- ================= PACKS ================= -->
<section class="section brick wall-value torn-top" id="packs">
  <div class="wall-photo" data-photo="bg-packs"></div>
  <div class="lamp-glow" style="top:-200px; right:8%; background: radial-gradient(circle, rgba(182,255,60,0.2), transparent 70%);"></div>
  <div class="wrap">
{head_block('packs.h', 'packs.p', 'var(--acid)')}
    <div class="pack-grid" id="packs-grid"></div>
    <p class="bundles" data-i18n="packs.bundles">{t('packs.bundles')}</p>
  </div>
</section>

<!-- ================= RARITY: CHARGE SCALE ================= -->
<section class="section brick wall-rarity torn-top" id="rarity">
  <div class="wall-photo" data-photo="bg-rarity"></div>
  <div class="lamp-glow" style="top:-220px; left:5%; background: radial-gradient(circle, rgba(22,229,217,0.26), transparent 70%);"></div>
  <div class="wrap">
{head_block('rarity.h', 'rarity.p', 'var(--cyan)')}
    <div class="charge-meter">
      <div class="meter-line"></div>
      <div class="meter-rows" id="meterRows"></div>
    </div>
    <p class="rarity-note" data-i18n="rarity.pity">{t('rarity.pity')}</p>
  </div>
</section>

<!-- ================= WORLD / LORE ================= -->
<section class="section brick wall-world torn-top" id="world">
  <div class="wall-photo" data-photo="bg-world"></div>
  <div class="lamp-glow" style="top:-200px; left:8%; background: radial-gradient(circle, rgba(182,255,60,0.18), transparent 70%);"></div>
  <div class="wrap">
{head_block('world.h', 'world.p', 'var(--acid)')}
    <p class="lore-body" data-i18n-html="world.body">{t('world.body')}</p>
    <div class="lore-facts">
      <span class="lore-fact" data-i18n="world.f1">{t('world.f1')}</span>
      <span class="lore-fact" data-i18n="world.f2">{t('world.f2')}</span>
      <span class="lore-fact" data-i18n="world.f3">{t('world.f3')}</span>
      <span class="lore-fact" data-i18n="world.f4">{t('world.f4')}</span>
    </div>
  </div>
</section>

<!-- ================= ECONOMY ================= -->
<section class="section brick wall-rules torn-top" id="economy">
  <div class="wall-photo" data-photo="bg-economy"></div>
  <div class="wrap">
{head_block('eco.h', 'eco.p', 'var(--trust)')}
    <div class="eco-grid">
      <div class="eco-card clean-zone">
        <h3 data-i18n="eco.alloc">{t('eco.alloc')}</h3>
        <div class="donut">
          {donut_svg()}
          <ul class="legend">
            <li><i style="background:#16E5D9"></i><b>55 %</b><span data-i18n="eco.a1">{t('eco.a1')}</span></li>
            <li><i style="background:#FF2E8A"></i><b>15 %</b><span data-i18n="eco.a2">{t('eco.a2')}</span></li>
            <li><i style="background:#FF7A1A"></i><b>15 %</b><span data-i18n="eco.a3">{t('eco.a3')}</span></li>
            <li><i style="background:#2E8BFF"></i><b>10 %</b><span data-i18n="eco.a4">{t('eco.a4')}</span></li>
            <li><i style="background:#B6FF3C"></i><b>5 %</b><span data-i18n="eco.a5">{t('eco.a5')}</span></li>
          </ul>
        </div>
        <p data-i18n="eco.guard">{t('eco.guard')}</p>
      </div>
      <div class="eco-card clean-zone">
        <h3 data-i18n="eco.emission">{t('eco.emission')}</h3>
        <div class="bars">
{bar('eco.e1', 20, '#16E5D9')}
{bar('eco.e2', 10, '#2E8BFF')}
{bar('eco.e3', 22, '#B6FF3C')}
{bar('eco.e4', 33, '#FF2E8A')}
{bar('eco.e5', 15, '#FF7A1A')}
        </div>
        <h3 class="mt" data-i18n="eco.sinks">{t('eco.sinks')}</h3>
        <div class="bars">
{bar('eco.s1', 100, '#FF2E8A')}
{bar('eco.s2', 75, '#FF2E8A')}
{bar('eco.s3', 100, '#FF2E8A')}
{bar('eco.s4', 40, '#FF2E8A')}
{bar('eco.s5', 33, '#FF2E8A')}
{bar('eco.s6', 100, '#FF2E8A')}
        </div>
        <p class="bar-key"><i></i><span data-i18n="eco.burned">{t('eco.burned')}</span></p>
      </div>
      <div class="eco-card clean-zone span-2">
        <h3 data-i18n="eco.fees">{t('eco.fees')}</h3>
        <table class="fee-table">
          <thead><tr><th data-i18n="eco.f.what">{t('eco.f.what')}</th><th data-i18n="eco.f.rate">{t('eco.f.rate')}</th><th data-i18n="eco.f.where">{t('eco.f.where')}</th></tr></thead>
          <tbody>
{fee_row('eco.f1', '7.5 %')}
{fee_row('eco.f2', '2.5 %')}
{fee_row('eco.f3', '5 %')}
{fee_row('eco.f4', '0.5 $CG')}
{fee_row('eco.f5', '$0.99 – $9.99')}
{fee_row('eco.f6', '−5 %')}
          </tbody>
        </table>
      </div>
      <div class="eco-card clean-zone skr-card span-2">
        <h3 data-i18n="eco.skr.h">{t('eco.skr.h')}</h3>
        <p class="m0" data-i18n="eco.skr.p">{t('eco.skr.p')}</p>
        <div class="mint"><b data-i18n="skr.mint">SKR mint</b> SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3 · <span data-i18n="skr.decimals">6 decimals</span> · Token Program · <b>Pyth</b> Crypto.SKR/USD</div>
        <div class="mint"><b data-i18n="skr.treasury">Treasury (SKR)</b> HPMr5r9sS5ApWsPNJytZRLbm2jz1veFxTn1wepjAhtho · <span data-i18n="skr.funding">Funds the prize pool weekly · ledger:</span> /v1/rewards/skr-pool</div>
      </div>
    </div>
  </div>
</section>

<!-- ================= MECHANICS ================= -->
<section class="section brick wall-mech torn-top" id="mech">
  <div class="wall-photo" data-photo="bg-mech"></div>
  <div class="lamp-glow" style="top:-200px; left:10%; background: radial-gradient(circle, rgba(255,46,138,0.22), transparent 70%);"></div>
  <div class="wrap">
{head_block('mech.h', 'mech.p', 'var(--magenta)')}
    <div class="mech-grid">
{mech_card(1, '⚗️')}
{mech_card(2, '🥊')}
{mech_card(3, '💰')}
{mech_card(4, '🏷️')}
{mech_card(5, '📋')}
{mech_card(6, '🎨')}
    </div>
  </div>
</section>

<!-- ================= RULES / FAIRNESS ================= -->
<section class="section brick wall-rules torn-top" id="rules">
  <div class="wall-photo" data-photo="bg-rules"></div>
  <div class="wrap">
{head_block('rules.h', 'rules.p', 'var(--trust)')}
    <div class="clean-zone mb">
      <div class="permit-grid" id="permitGrid"></div>
    </div>
    <ul class="rule-list">
      {''.join(f'<li><span class="rule-dot"></span><span data-i18n="rules.{i}">{t(f"rules.{i}")}</span></li>' for i in range(1, 8))}
    </ul>
    <p class="disclaimer" data-i18n="rules.disclaimer">{t('rules.disclaimer')}</p>
  </div>
</section>

<!-- ================= ROADMAP ================= -->
<section class="section brick wall-road torn-top" id="road">
  <div class="wall-photo" data-photo="bg-road"></div>
  <div class="lamp-glow" style="top:-200px; left:12%; background: radial-gradient(circle, rgba(255,122,26,0.24), transparent 70%);"></div>
  <div class="wrap">
{head_block('road.h', 'road.p', 'var(--orange)')}
    <div class="layers">
{layer(1, 'var(--chrome)', 'road.s1')}
{layer(2, 'var(--cyan)', 'road.s2')}
{layer(3, 'var(--magenta)', 'road.s3')}
{layer(4, 'var(--acid)', 'road.s4')}
    </div>
  </div>
</section>

<!-- ================= FAQ ================= -->
<section class="section brick wall-events torn-top" id="faq">
  <div class="wall-photo" data-photo="bg-value"></div>
  <div class="lamp-glow" style="top:-200px; right:6%; background: radial-gradient(circle, rgba(255,46,138,0.24), transparent 70%);"></div>
  <div class="wrap">
{head_block('faq.h', 'faq.p', 'var(--magenta)')}
    <div class="faq">
{faq_html()}
    </div>
  </div>
</section>

<!-- ================= STATS (live, honest) ================= -->
<section class="section brick wall-stats torn-top" id="stats">
  <div class="wall-photo" data-photo="bg-stats"></div>
  <div class="wrap">
{head_block('stats.h', 'stats.p', 'var(--trust)')}
    <div class="stats-grid">
      <div class="stat clean-zone"><div class="stat-num pending" data-stat="chipsAlive">—</div><div class="stat-label" data-i18n="stats.1">{t('stats.1')}</div></div>
      <div class="stat clean-zone"><div class="stat-num pending" data-stat="packsOpened">—</div><div class="stat-label" data-i18n="stats.2">{t('stats.2')}</div></div>
      <div class="stat clean-zone"><div class="stat-num pending" data-stat="activeWallets">—</div><div class="stat-label" data-i18n="stats.3">{t('stats.3')}</div></div>
      <div class="stat clean-zone"><div class="stat-num pending" data-stat="totalBattlesResolved">—</div><div class="stat-label" data-i18n="stats.4">{t('stats.4')}</div></div>
    </div>
    <p class="stats-note"><span id="stats-status" data-i18n="stats.offline">{t('stats.offline')}</span> · <span data-i18n="stats.source">{t('stats.source')}</span></p>
  </div>
</section>

<!-- ================= COLLECTIONS: THE EIGHT DISTRICTS ================= -->
<section class="section brick wall-collections torn-top" id="collections">
  <div class="wall-photo" data-photo="bg-collections"></div>
  <div class="lamp-glow" style="top:-200px; right:6%; background: radial-gradient(circle, rgba(255,122,26,0.2), transparent 70%);"></div>
  <div class="wrap">
{head_block('districts.h', 'districts.p', 'var(--orange)')}
    <noscript><p>Night Moth · Asphalt Devils · Rail Kings · Gutter Soles · Boombox Block · Gutter Beasts · Pixel Basement · City Myths — nine tiers each, Common → Diamond.</p></noscript>
    <div id="districts"></div>
  </div>
</section>

<!-- ================= COMMUNITY ================= -->
<section class="section brick wall-world torn-top" id="community">
  <div class="wall-photo" data-photo="bg-events"></div>
  <div class="wrap">
{head_block('community.h', 'community.p', 'var(--cyan)')}
    <div class="community">
{community_links(True)}
    </div>
  </div>
</section>
</main>

<!-- ================= FOOTER ================= -->
<footer class="brick wall-foot torn-top">
  <div class="wall-photo" data-photo="bg-hero"></div>
  <div class="deck">
    <h3 class="tag-heading deck-h" data-i18n-html="foot.h">{t('foot.h')}</h3>
    <p data-i18n="foot.p">{t('foot.p')}</p>
    <a class="btn-spray btn-spray-lg mb" data-link="app" href="#" onclick="fireSpray(this)"><span class="mist-puff"></span><span data-i18n="foot.cta">{t('foot.cta')}</span></a>
    <div class="deck-links">
{community_links(False)}
    </div>
  </div>
  <p class="fine-print foot-legal">
    <span class="age-badge" title="18+">18+</span>
    <a data-link="terms" href="#" rel="noopener" data-i18n="footer.terms">Terms</a>
    <a data-link="privacy" href="#" rel="noopener" data-i18n="footer.privacy">Privacy</a>
  </p>
  <p class="fine-print">{LOGO_SVG} <span data-i18n="foot.fine">{t('foot.fine')}</span></p>
</footer>
'''

RU = {k: v[1] for k, v in T.items()}
DATA_JS = (
    'const RU = ' + json.dumps(RU, ensure_ascii=False) + ';\n'
    + '  const I18N = ' + json.dumps(TRANSLATIONS, ensure_ascii=False) + ';\n'
    + '  const LANG_TAGS = ' + json.dumps(TAGS, ensure_ascii=False) + ';\n'
    + '  const LORE = ' + json.dumps(LANDING_CATALOG, ensure_ascii=False) + ';\n'
    + '  const UI = ' + json.dumps(LANDING_UI, ensure_ascii=False) + ';\n'
    + '  const DISTRICT_ART = ' + json.dumps(DISTRICT_ART) + ';\n'
    + '  const DISTRICT_ART_GEO = ' + json.dumps({'tile': ART_TILE, 'gut': ART_GUT, 'pad': ART_PAD}) + ';\n'
    + '  const TIERS = ' + json.dumps([{'key': k, 'color': c, 'odds': o, 'power': p, 'level': l, 'weight': w} for k, c, o, p, l, w in TIERS], ensure_ascii=False) + ';\n'
    + '  const PACK_ART = ' + json.dumps(PACK_ART) + ';\n'
    + '  const HOWTO = ' + json.dumps(HOWTO, ensure_ascii=False) + ';\n'
    + '  const PACKS = ' + json.dumps(PACKS, ensure_ascii=False) + ';\n'
    + '  const STEP_ART = ' + json.dumps(STEP_ART) + ';\n'
)

SCRIPT = (HERE / 'app.js').read_text()
SCRIPT = (SCRIPT.replace('/*__DATA__*/', DATA_JS)
               .replace('/*__CHANNELS__*/', CHANNELS_LINKS_JS)
               .replace('/*__STEP_ART__*/', '')
               .replace('/*__COLLECTIONS__*/', COLLECTIONS_JS.rstrip() + '\n'))
# Every placeholder must have been filled. A `/*__X__*/` surviving into the page would ship
# as literal text in the script, and the failure would be silent and confusing: a renamed
# placeholder compiles fine, the built file looks fine, the feature is just gone.
assert '/*__' not in SCRIPT, f'unfilled build placeholder in app.js: {SCRIPT[SCRIPT.index("/*__"):][:40]}'

out = HEAD + BODY + '\n<script>\n' + SCRIPT.rstrip() + '\n</script>\n</body>\n</html>\n'
# `</script>` inside JSON would end the ld+json block early
assert '</script' not in jsonld_faq() and '</script' not in jsonld_game()
OUT.write_text(out)
print(f'wrote {OUT.relative_to(ROOT)}: {len(out):,} bytes, {len(T)} i18n keys, {len(FAQ)} FAQ entries')
