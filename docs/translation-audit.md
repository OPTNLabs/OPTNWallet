# OPTN Wallet translation coverage audit

Date: 2026-08-09

## Scope

This audit covers the mobile and desktop wallet UI. Browser-extension code is
excluded. It distinguishes wallet-owned UI from add-on-owned UI so that
third-party translation bundles do not become part of the core wallet catalog.

## Executive finding

The recovered `codex/automated-testing` branch contains the shared
localization implementation and the original English/Spanish/Simplified Chinese
catalog. The current work extends that foundation with Brazilian Portuguese,
Vietnamese, Traditional Chinese, Arabic, French, Korean, Japanese, Russian,
and Hausa (Nigeria) rather than replacing it:
the provider is mounted from `src/main.tsx`, locale preference is persisted in
Redux, Settings exposes the language toggle, and resource-parity tests require
all supported locales to have the same non-empty keys.

The catalog is now audited by policy rather than by raw English-equality
counts. Stable protocol/product identifiers, external add-on values, and
internal-only keys are reported separately from values that still need review.
The source-literal audit also scans mobile and desktop core UI for visible JSX
text and static accessibility attributes.

## Historical implementation found

The earlier basic localization work does exist in Git:

- commit `3e0a1888` — `Checkpoint localization and wallet development`
  (2026-08-04);
- local branch `codex/automated-testing` contains that commit and continues to
  `71e6fd99`;
- current `dev` does not contain the commit. The two branches have diverged
  substantially (`486` commits unique to `dev`, `475` unique to
  `codex/automated-testing`).

That checkpoint added the three-locale foundation, locale persistence in the
preferences slice, `I18nProvider`/`useI18n`, a Settings language control and a
language picker, broad core-screen wiring, resource completeness tests, and a
peer-review CSV containing 1,413 translation keys. It also touched 217 files
in total, so merging or cherry-picking the whole checkpoint would bring in
unrelated wallet, CI, and platform changes and should not be done blindly.

The initial audit described the `dev` checkout. This updated report records the
recovered branch as the active localization starting point.

## Ownership boundary

## Stable-term policy

`src/i18n/translationPolicy.ts` is the canonical policy map used by both the
CSV exporter and the audit script. It classifies only explicitly registered
keys or values as `stable-term`; a sentence that merely contains `BCH`,
`CashFusion`, `WalletConnect`, or another identifier still needs translation
around that term. Reserved `addon.external.*` / `apps.external.*` prefixes are
classified as `external-value`, while `internal.*` / `test.*` are
`internal-only`. Dynamic manifest, dApp, token, address, transaction-ID, and
iframe values remain outside the catalog and are reviewed at their host
boundary.

The policy preserves the product/protocol vocabulary agreed for this project,
including `Quantumroot`, `WalletConnect`, `WizardConnect`, `CashFusion`,
`CashTokens`, `Bitcoin Cash`, `BIP39`, `BIP21`, `BIP37`, `BIP44`, `NFT`, `FT`,
`UTXO`, `xPub`, `PSBT`, `OP_RETURN`, `RPC`, `QR`, `WSS`, `NIP-06`, `NIP-17`,
`CoinJoin`, `Outpoint`, `Sats`, `Paycode`, `RPA`, and `dApp`. Product names
remain English while their surrounding descriptions and controls are
localized. The policy also records intentional equivalent UI labels such as
`OK`, `Console`, `Status`, `Token`, and common French cognates so a valid
translation that happens to equal English is not reported as a fallback.
BIP39 generation, detection, and validation use the English word list for
every UI locale.

### Core wallet: translated by OPTN Wallet

The core catalog should own all wallet shell and first-party wallet workflows:

- app shell, navigation, page headers, empty states, shared controls, and
  accessibility labels;
- onboarding, wallet creation/import, recovery phrase, watch-only flows, and
  desktop wallet selection;
- home, assets, receive, send, outbox, transaction builder, confirmation,
  transaction history, and notifications;
- settings, app lock, encryption, network/server/Tor/CashFusion controls,
  hardware-wallet controls, console, and experimental-feature controls;
- contract browsing and contract-instance management supplied by the wallet;
- WalletConnect and WizardConnect approval/session UI. The product names stay
  `WalletConnect` and `WizardConnect`, but their surrounding descriptions and
  controls are translated;
- Quantumroot, RPA, and other first-party wallet functionality;
- About, terms, contact/help, faucet instructions, and desktop native menus;
- add-on manager and the host chrome around an add-on.

The original audit inventory was broad. The current implementation has covered
the shell, critical send/receive/app-lock paths, connection hosts, operational
wallet flows, privacy/chat/RPA surfaces, QR signing, contract browsing and
descriptions, CashFusion/P2P controls, transaction-builder shell controls,
Quantumroot workspace status, and wallet-owned add-on host chrome. Remaining
first-party gaps are concentrated in detailed Quantumroot popup/toast copy and
lower-level transaction-builder fields, plus a small number of isolated labels.
The table below is retained as a coverage map rather than a claim that every
listed gap is still open:

| Surface                   | Representative files                                                                                                                                                                                                        | Main gaps                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Shell and navigation      | `src/components/Layout.tsx`, `src/components/BottomNavBar.tsx`, `src/features/settings/Settings.tsx`, `src/features/settings/settingsConfig.ts`                                                                             | Navigation labels, settings groups/rows, theme and accessibility labels                                 |
| Onboarding and security   | `src/features/onboarding/LandingPage.tsx`, `CreateWalletPage.tsx`, `ImportWalletPage.tsx`, `src/platform/desktop/onboarding/*`, `src/platform/desktop/AppLockGate.tsx`, `AppLockSettings.tsx`, `DesktopSecurityGate.tsx`    | Headings, instructions, passwords, validation errors, toasts, loading states, desktop wallet-file flows |
| Wallet overview           | `src/features/home/Home.tsx`, `src/pages/Assets.tsx`, `src/pages/Receive.tsx`, `src/pages/Outbox.tsx`                                                                                                                       | Page copy, section labels, placeholders, empty states, QR controls, copy errors, relative-time text     |
| Send and transactions     | `src/features/simple-send/*`, `src/features/transaction/*`, `src/components/confirm/TxSummary.tsx`, `src/components/WalletConfirmDialog.tsx`                                                                                | Recipient/amount/token labels, QR actions, fee text, transaction build/confirm/send states, warnings    |
| History and notifications | `src/features/transaction-history/*`, `src/components/notifications/*`, `src/components/UTXOCard.tsx`                                                                                                                       | Status labels, pagination, dates/relative time, dismiss actions, UTXO metadata labels                   |
| Contracts                 | `src/features/contract-view/ContractView.tsx`, `src/components/ContractDetails.tsx`, `src/components/ContractModal.tsx`                                                                                                     | Core workflow and descriptions are covered; native review remains for long technical copy               |
| Settings and connections  | `src/features/settings/*`, `src/components/walletconnect/*`, `src/components/wizardconnect/*`, `src/components/connect/*`                                                                                                   | Most settings-panel copy, status text, prompts, session labels, accessibility text                      |
| Advanced wallet features  | `src/pages/Quantumroot.tsx`, `src/pages/quantumroot/*`, `src/features/rpa/*`, `src/features/nostr/*`, `src/features/settings/CashFusionSettings.tsx`, `TorSettings.tsx`, `ServerSettings.tsx`, `HardwareWalletSettings.tsx` | Detailed Quantumroot popup/toast copy and lower-level builder fields remain                             |
| Informational/legal       | `src/components/AboutView.tsx`, `src/components/TermsOfUse.tsx`, `src/components/ContactUs.tsx`, `src/components/FaucetView.tsx`                                                                                            | Entire visible documents and faucet instructions are English literals                                   |
| Desktop chrome            | `src/platform/desktop/useMenuBar.ts`, `CameraQrScanner.tsx`, desktop onboarding/security files                                                                                                                              | Native menu titles, file-dialog titles, scanner labels, desktop-only errors and toasts                  |

The source files above are representative, not an exhaustive string inventory.
Run `npx tsx scripts/audit-source-literals.mjs` after adding core UI. It is a
heuristic review aid, not an AST proof: dynamic user data, protocol
diagnostics, internal logs, and add-on-owned content must be triaged manually.

### Add-on-owned: translated by the add-on developer

The following should not be added to the core wallet translation catalog:

- third-party iframe app screens and add-on-specific business logic;
- third-party add-on names, descriptions, contract names, function names,
  token names, and other manifest-supplied metadata;
- third-party iframe-bundle UI and its errors displayed inside the iframe.

First-party declarative screens under `src/pages/apps/**` are wallet-owned when
they are registered by the built-in registry. Their visible copy belongs in
the add-on's locale bundle and is migrated with `useAddonI18n`; only the
third-party iframe boundary remains external.

The manifest model now supports optional add-on-owned `localeBundles`. Add-on
developers can ship metadata and screen messages with their app bundle. For
built-in declarative add-ons, locale resources live beside the built-in add-on
registry and screens use `AddonI18nProvider`; they still do not enter the core
wallet catalog.

### Wallet-owned add-on host: translated by OPTN Wallet

The add-on boundary does not make every file under `src/pages/apps` external.
The wallet still owns the host and must translate its chrome:

- `src/features/apps/AppsView.tsx`: page header, browse/filter labels, loading
  and failure states, and built-in wallet cards such as Contracts, Quantumroot,
  CashFusion, and Chat;
- `src/pages/apps/MarketplaceAppHost.tsx`: loading/failure/back states,
  unsupported-app diagnostics, no-wallet state, coming-soon state, and
  capability-consent text;
- `src/pages/apps/AddonIframeHost.tsx`: loading and host failure states;
- `src/features/settings/AddonsSettings.tsx`: installed-add-ons manager copy;
- `src/services/addons/AddonInstallService.ts` and
  `src/platform/desktop/AddonInstallService.ts`: host file-dialog and
  installation errors.

Dynamic add-on values such as `resolved.app.name`, `manifest.description`,
capability identifiers, contract metadata, and add-on errors should be treated
as external content. Translate the host sentence around them, not the values
themselves.

## Current implementation status

- Core catalog remains split into `src/i18n/coreResources.ts` and
  `src/i18n/remainingResources.ts`, merged by `src/i18n/resources.ts`.
- All twelve locales have identical, non-empty runtime keys. `ar` is the most
  complete non-base catalog; `pt-BR`, `vi`, `zh-TW`, `fr`, `ko`, `ja`, `ru`,
  and `ha-NG` still contain policy-classified `needs-review` fallbacks. These
  are visible row-by-row in the peer-review exports and remain implementation
  work, not completed translations.
- `src/i18n/translationPolicy.ts` is the documented stable-term and ownership
  boundary. It deliberately classifies a sentence containing a stable term as
  translatable unless the whole value/key is explicitly stable.
- `scripts/audit-translations.mjs` checks key parity, empty values,
  placeholder parity, and per-locale policy counts. `scripts/export-translations.mjs`
  includes the same status in every CSV.
- The latest audit has zero missing keys, extra keys, or placeholder
  mismatches in all twelve locales. It still reports `needs-review` fallbacks
  in the sparse locales; those are intentionally not hidden by the policy.
- Hardware-wallet controls are now localized for all twelve locales, including
  desktop security/menu host surfaces and the English-only BIP39 guidance.
- The newer-locale override layers now cover the critical send/receive/app-lock
  workflows, WalletConnect/WizardConnect session UI, server/outbox/desktop
  platform copy, paper-wallet/watch-only/derivation/reconfiguration flows,
  Tor/RPA/Nostr/chat surfaces, QR signing, contract-function dialogs, and
  wallet-owned add-on marketplace/permission chrome.
- `scripts/audit-addon-literals.mjs` inventories user-visible literals in
  built-in declarative add-on screens separately from the core source audit.
- Additional focused layers cover shared asset/history/onboarding/console/BIP37
  surfaces, contract browsing and descriptions, CashFusion/P2P controls,
  transaction-builder shell controls, Quantumroot workspace status, and
  residual technical labels. `resources.ts` remains the single merged runtime
  catalog.
- Peer-review exports remain available under `docs/translations/`, with the
  generated Markdown companion and export script.
- Wallet-owned add-on host chrome is translated. Built-in add-on metadata now
  has reviewed bundles for all twelve locales, and the sandbox passes the
  selected locale to third-party iframe add-ons. The nine repo-owned module
  catalogs under `src/pages/apps/**/locales.ts` now provide all twelve locales;
  Marketplace screens merge the matching module catalog with manifest-owned
  messages, and standalone mobile/desktop routes use
  `AddonModuleI18nProvider`. Remaining heuristic literals are limited to the
  unreferenced legacy `src/pages/apps/FundMe.tsx` screen, data/protocol values,
  and numeric/input examples. The routed legacy campaign detail and its pledge
  and consolidation dialogs now use the FundMe module catalog.
- Quantumroot state-helper strings remain English internally for test/API
  stability. The workspace shell is localized; detailed popup/toast copy is
  still explicitly marked `needs-review` in the sparse-locale exports.
- `WalletConnect` and `WizardConnect` remain English product names; their
  descriptions and controls are translated.
- The remaining sparse-locale fallback counts are concentrated in detailed
  Quantumroot popup/toast strings (about 169 per sparse locale) and
  transaction-builder field/details strings (about 55 per sparse locale), with
  a handful of isolated labels elsewhere. They remain `needs-review` in the
  exports rather than being misclassified as complete.

## Priority order

### P0: language foundation and critical wallet paths — foundation complete; catalog completion in progress

1. Locale state for `en`, `es`, `zh-CN`, `pt-BR`, `vi`, `zh-TW`, `ar`, `fr`,
   `ko`, `ja`, `ru`, and `ha-NG` is persisted on mobile and desktop, and
   exposed in Settings.
2. A shared `t(key, params)` API is usable from React, desktop menu code,
   services, and toast helpers, with English fallback and missing-key
   diagnostics in development.
3. Shell/navigation, onboarding, security gates, Assets, Receive,
   Send, Outbox, transaction confirmation, and transaction history.
4. Accessibility labels, placeholders, error toasts, and loading /
   empty states at the same time as their visible labels.

### P1: remaining core-workflow audit

- re-run the static literal audit when new core screens are added;
- normalize dynamic service errors where they are shown directly to users;
- translate any remaining desktop file-dialog/scanner labels not covered by the
  existing shell catalog;
- add locale-aware pluralization and date/relative-time formatting to the
  surfaces that still concatenate English units.

### P2: polish and audit enforcement

- pluralization and locale-aware relative time/number formatting;
- technical accessibility/title attributes and debug panels;
- static checks that flag new user-facing literals in core UI;
- catalog parity tests for all twelve locales and screenshot checks at longer
  translated string lengths, including Arabic RTL layouts.

## Add-on translation contract

Keep the core export limited to wallet-owned keys. Add-ons should ship their
own locale files and expose the messages needed for manifest metadata and
their screens through the optional `localeBundles` field. Built-in declarative
add-ons use the same shape.

For iframe-bundle add-ons, the host should pass the selected locale through
the existing SDK/message boundary and notify the iframe when it changes. The
iframe remains responsible for translating its own UI. The host should only
translate host chrome and should never merge untrusted add-on strings into the
core catalog.

See [`docs/addon-localization.md`](./addon-localization.md) for the manifest
shape, sandbox API, ownership boundary, and review checklist. The runtime
validates bundle size/shape and falls back to English or the add-on's original
manifest value when a requested locale is absent.

## Values that should remain external or product-stable

Do not translate user-provided or protocol data: BCH/CashTokens, addresses,
transaction IDs, token symbols/names, contract artifact/function names,
WalletConnect/WizardConnect product names, Nostr messages, dApp-provided
prompts, server names, and backend error text. Translate the surrounding wallet
labels and normalize known wallet-owned errors into translation keys.

## Verification performed

- Confirmed the recovered branch contains the `src/i18n` implementation and
  locale provider.
- Inspected `src/main.tsx`, `src/app/AppShell.tsx`, settings configuration,
  core wallet screens, desktop chrome, add-on types/manifest schema, and add-on
  host components.
- Excluded `src/platform/extension/**` from the audit as requested.
- Confirmed the add-on manifest/schema supports validated locale bundles, with
  built-in metadata coverage and sandbox locale propagation.
- The core validation passed `format:check`, `typecheck:core`, `lint:core`,
  add-on manifest validation, and the focused i18n/add-on suite (54 tests).
  The full core suite passed (148 files passed, 2 tests skipped), and
  `build:web`.
- The final export contains 12 CSV files with 1,721 rows each. The add-on
  literal audit currently reports 48 heuristic candidates; the actionable
  active-module UI has been migrated, while the remaining results are the
  unreferenced legacy FundMe screen, input examples, protocol
  values/diagnostics, or stable capability terms.

The report is intentionally untracked so it can be shared or revised with the
peer-review materials.
