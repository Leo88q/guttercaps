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
- [ ] Short description (~1 sentence)
- [ ] Long description — draw from the site's "Mechanics" and "Rules &
      fairness" sections (guttercaps-landing.html) rather than writing
      fresh; keep the same honesty about odds/fees, don't oversell
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
- [ ] Privacy policy / terms / copyright URLs (required fields — even a
      simple static page works, but they must resolve)
- [ ] Signed APK path: `app/build/outputs/apk/release/app-release.apk`
      after `solana-mobile webshell build`
