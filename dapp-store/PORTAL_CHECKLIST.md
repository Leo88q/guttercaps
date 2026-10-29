> **Legal review (2026-09-29): incomplete; technical deployment blocker removed by owner request.** See
> [launch readiness](../docs/legal/LAUNCH-READINESS.md). A publisher/brand is not a substitute
> for the actual legal operator. Submit truthful entity contacts; provide any required
> director/beneficial-owner verification privately to the platform. Do not submit draft
> policies as approved, a nonexistent licence, or a guessed legal address.

# Publisher Portal submission notes

The old CLI flow this file used to configure (`dapp-store create-publisher`
/ `create-app` / `create-release` reading a local `config.yaml`) is no
longer how a **first** submission works. As of the current docs
(docs.solanamobile.com/dapp-publishing/overview), the flow is:

1. Create your app in the **Publisher Portal** (https://publish.solanamobile.com)
   — a web form, not a CLI command. This mints the Publisher NFT and App
   NFT for you when you submit the form.
2. Upload your signed release APK (from `solana-mobile webshell build`,
   see the main README's "Мобильная упаковка" section) as a **New
   Version** in the portal. This mints the Release NFT.
3. Submit for review from the portal.

Only **subsequent updates** use the CLI (`@solana-mobile/dapp-store-cli`),
and even then it's a thin wrapper that just uploads a new APK to the
already-existing portal app using an API key — not the old NFT-minting
command chain:

```bash
npm install -g @solana-mobile/dapp-store-cli
export DAPP_STORE_API_KEY=<from https://publish.solanamobile.com/dashboard/settings/api-keys>
dapp-store --apk-file ./app/build/outputs/apk/release/app-release.apk \
  --keypair ./path/to/keypair.json \
  --whats-new "What changed in this version"
```

This file is just a checklist of what the portal form will ask for —
filling it in doesn't do anything by itself, unlike the old config.yaml.

## Checklist for the portal form

- [ ] Publisher name / website / contact email
- [ ] App name: GUTTERCAPS
- [ ] Android package id: match whatever `solana-mobile webshell init`
      generated (`--application-id`, default derived from the app name)
- [ ] Short description (~1 sentence) — ready to paste, see “Listing texts” below
- [ ] Long description — ready to paste, see “Listing texts” below
      (drawn from the site's "Mechanics" / "Rules & fairness" honesty:
      odds fixed before payment, Verify recomputes every roll, no oversell)
- [ ] Category: Games
- [x] Icon 512×512 PNG, no alpha — `media/icon-512.png` (copied from
      `client/public/icon-512.png`, alpha checked pixel-wise)
- [x] Banner 1200×600 PNG — `media/banner.png` (cropped from
      `art_drafts/site/banner-01.png`, Night Moth street scene)
- [ ] Minimum 4 screenshots or videos, 1080p — the ONLY remaining media item.
      Browser-based QA is now available, but approved 1080p store captures
      still need to be produced and checked. Fastest path for a first pass: `npm run e2e:build` +
      `npx vite preview` on client/dist, open Chrome devtools → device toolbar
      → 1080×1920 on `/`, `/shop`, `/codex`, `/market`, capture each
      (Ctrl+Shift+P → "Capture full size screenshot"). For submission,
      prefer on-device captures of the same screens per media/README.txt.
## Listing texts (ready to paste)

App name: `GUTTERCAPS`
Category: Games

### Short description

EN: Open packs, hunt rare caps across 8 districts, fuse duplicates — and
verify every roll yourself. Your caps are real cNFTs in your Solana wallet.

RU: Открывай паки, собирай редкие фишки восьми районов, сливай дубли — и
проверяй каждый ролл сам. Твои фишки — настоящие cNFT в Solana-кошельке.

### Long description (EN)

GUTTERCAPS is a street-culture collecting game on Solana. Hunt caps across
eight districts — from NIGHTMOTH rooftops to PIXELBASE arcades — open packs,
fuse duplicates into rarer finds, and build the collection the whole block
talks about.

• OPEN PACKS — the odds of every pack are fixed and cryptographically
committed before you pay. After opening, hit Verify: anyone can recompute
the roll from the revealed seed and check the game played fair.

• COLLECT FOR REAL — your caps are compressed NFTs (cNFTs) minted straight
into your Solana wallet. They are yours: keep them, flex them, or trade
them on external marketplaces.

• FUSE — burn three duplicates for a shot at a higher rarity.

• SOFT STAKING — park caps to earn $CG, the in-game token, over time.

• FAIR BY DESIGN — a public issuance journal and pre-committed rolls; the
odds cannot quietly change after your payment. At launch, minting runs
through the game server against that public log while the fully on-chain
mode (built and tested) rolls out.

Start free in the guest demo; connect a Solana wallet when you are ready to
collect for keeps. Available in 7 languages. Pack purchases are 18+.

Caps are collectibles for entertainment — not an investment, and like any
crypto asset they can lose value.

### Long description (RU)

GUTTERCAPS — коллекционная игра уличной культуры на Solana. Собирай фишки
восьми районов — от крыш NIGHTMOTH до аркад PIXELBASE: открывай паки, сливай
дубли в более редкие находки и собери коллекцию, о которой говорит весь
район.

• ОТКРЫВАЙ ПАКИ — шансы каждого пака зафиксированы и криптографически
закоммичены до оплаты. После открытия нажми Verify: любой может пересчитать
ролл из раскрытого сида и убедиться, что игра была честной.

• КОЛЛЕКЦИОНИРУЙ ПО-НАСТОЯЩЕМУ — фишки это сжатые NFT (cNFT), которые
минтятся прямо в твой Solana-кошелёк. Они твои: храни, показывай или
продавай на внешних площадках.

• СЛИЯНИЕ — сжигай три дубля ради шанса на более высокую редкость.

• МЯГКИЙ СТЕЙКИНГ — отправляй фишки «отдохнуть» и получай $CG, игровой
токен, со временем.

• ЧЕСТНО ПО ДИЗАЙНУ — публичный журнал выпуска и роллы, зафиксированные до
оплаты: шансы не могут тихо измениться после платежа. На запуске минт идёт
через игровой сервер по этому публичному журналу, а полностью ончейн-режим
(готов и протестирован) включается следом.

Начни бесплатно в гостевом демо; подключи Solana-кошелёк, когда будешь
готов собирать всерьёз. Игра на 7 языках. Покупка паков — 18+.

Фишки — коллекционные предметы для развлечения, а не инвестиция; как любой
криптоактив, они могут потерять ценность.

### Screenshots (shot list, 1080p portrait ×4 minimum)

Capture from the phase-G store build (`LAUNCH_PHASE=g`, English UI, light
state prepared in advance). No admin/debug panels, no RPC URLs, addresses
or other technical readouts in frame.

1. `screenshot-home.png` — home: hero + districts/packs row.
   State: guest demo or connected wallet. Caption EN “Eight districts. One
   collection.” RU «Восемь районов. Одна коллекция.»
2. `screenshot-packs.png` — `/shop`: pack cards with prices and odds.
   Caption EN “Odds fixed before you pay.” RU «Шансы зафиксированы до
   оплаты.»
3. `screenshot-codex.png` — `/codex`: collection grid with ≥6 owned chips
   across districts (prepared account). Caption EN “Hunt them all.”
   RU «Собери их все.»
4. `screenshot-verify.png` — pack journal / Verify screen with
   `matches=true`. Caption EN “Don't trust. Verify.” RU «Не верь. Проверяй.»
   Optional 5th: fusion screen (3 duplicates → 1) — “Fuse the dups.”

Capture path (per the media note below): device toolbar 1080×1920 on the
client build, or on-device captures of the same screens; check each PNG at
100% zoom for stray toasts/panels before uploading.

- [ ] Privacy policy / terms / copyright URLs (required fields — even a
      simple static page works, but they must resolve)
- [ ] Signed APK path: `app/build/outputs/apk/release/app-release.apk`
      after `solana-mobile webshell build`
