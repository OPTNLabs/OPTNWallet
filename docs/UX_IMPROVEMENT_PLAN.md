# OPTN Wallet UX Improvement Plan

## Summary

The current UI is feature-rich, but it asks users to interpret too much at once. The main improvement is not more visual polish; it is clearer hierarchy, fewer equal-weight choices, and more task-first flows.

The goal is to make every screen answer one primary question:

- Home: What do I have, and what should I do next?
- Receive: Which address should I share?
- Send: Who am I sending to, and what am I sending?
- History: What happened recently?
- Apps: Which tool should I open?
- Settings: What do I configure or recover?

## Priority order

### 1. Clarify the home screen

Home currently behaves like a control room. It exposes balance, contracts, apps, Quantumroot, address creation, sync, and token inspection at the same level.

Change this to a simpler entry point:

- Keep balance and wallet status at the top.
- Make one primary next action obvious.
- Move less frequent actions into grouped secondary sections.
- Treat sync as a utility action, not a competing primary action.

Recommended home hierarchy:

1. Balance and network status
2. Primary action, likely receive/address creation
3. Secondary wallet tools
4. Advanced features
5. Token details

### 2. Turn Send into a guided flow

The send experience already has good building blocks, but it still feels like a dense form rather than a guided task.

Change this to:

- Recipient first
- Asset second
- Amount third
- Review last

Keep the review action prominent and make reset clearly secondary. If there is an advanced builder, frame it as an alternate path rather than a competing one.

### 3. Simplify Receive around one selected address

Receive currently shows too many addresses and address types at once. That forces users to understand wallet internals before they can share funds.

Change this to:

- Show one selected address clearly.
- Put the QR code and copy/share action front and center.
- Use tabs or segmented controls for main and change addresses.
- Separate Quantumroot into its own subsection if it remains relevant on this screen.

### 4. Reframe Apps by intent

The Apps screen is a flat grid of tools. That is technically complete, but it is not especially discoverable.

Change this to:

- Group tools by user intent.
- Add short “best for” descriptions.
- Highlight the most common or recommended apps first.
- Avoid making every tile feel equally important.

### 5. Reduce density in Transaction History

History is usable, but the current layout makes the user parse hashes and pagination before the status of the transaction is obvious.

Change this to:

- Put status first.
- Surface amount and direction when available.
- Make filtering controls compact.
- Consider simpler pagination if the current control set feels heavy.

### 6. Reorganize Settings into sections

Settings is acting like a catch-all. Security, integrations, support, network tools, and logout should not all compete in one grid.

Change this to:

- Group settings by purpose.
- Keep the theme toggle visible.
- Put destructive actions in a separate block.
- Give integrations a short explanation so they do not feel opaque.

## Screen-by-screen proposal

### Home

Current problems:

- Too many actions are visible at once.
- Feature labels compete with task labels.
- Advanced functionality appears before the user needs it.

Proposed layout:

- Header
- Balance card
- Primary action block
- Secondary tools block
- Token summary

Suggested copy changes:

- `Sync` -> `Refresh`
- `Show CashTokens` -> `View tokens`
- `Quantumroot Vaults` -> `Advanced vaults` or `Vaults`
- `Apps` -> keep as-is
- `Contracts` -> keep as-is if the audience already understands it

### Receive

Current problems:

- Too much address data is shown at once.
- Main and change addresses are visually similar.
- The action of sharing an address is not the strongest visual cue.

Proposed layout:

- Selected receive address
- Large QR code
- Copy/share actions
- Main/change address switcher
- Advanced receive modes

Suggested copy changes:

- `Main Addresses` -> `Receive`
- `Change Addresses` -> `Change addresses`
- Add short helper text for change addresses to explain why they exist

### Send

Current problems:

- The form is functional, but not strongly guided.
- Asset selection, destination, and amount all appear at roughly the same weight.
- The user must mentally assemble the send flow.

Proposed layout:

- Step 1: recipient
- Step 2: asset
- Step 3: amount
- Step 4: review

Suggested copy changes:

- `Simple Send` -> `Send`
- `Advanced` -> `Advanced builder`
- `Reset` should remain secondary

### Transaction History

Current problems:

- Transaction hashes dominate the list.
- Status is present, but not the first thing the eye sees.
- Pagination and filters take up a lot of attention.

Proposed layout:

- Filter toolbar
- Transaction list with strong status cues
- Pagination or “load more” footer

Suggested copy changes:

- `Newest first` / `Oldest first` is fine
- `10 per page` can become `Page size` if you want more clarity

### Apps

Current problems:

- The app grid is visually flat.
- Users have to know what each app does before they choose.
- There is no strong “recommended” path.

Proposed layout:

- Featured apps section
- Grouped categories
- Full catalog below

Suggested grouping:

- Create
- Distribute
- Sweep
- Swap
- Campaigns

### Settings

Current problems:

- Security, support, integration, and maintenance actions are mixed together.
- Log out is visually strong, but everything else is too uniform.

Proposed layout:

- Security
- Integrations
- Support
- Network tools
- Destructive actions

## Shared design-system changes

These changes will improve consistency across the app:

- Define one true primary button per screen.
- Make secondary buttons visually lighter.
- Reserve danger styling for destructive actions only.
- Use section headers more aggressively.
- Reduce repeated card emphasis so important cards can stand out.
- Prefer task language over internal feature names where possible.

## Copy cleanup recommendations

Use clearer labels where they reduce mental load:

- `Sync` -> `Refresh`
- `Show CashTokens` -> `View tokens`
- `Go Back` -> `Back to apps` or `All apps`
- `Quantumroot Vaults` -> `Vaults` or `Advanced vaults`
- `Simple Send` -> `Send`

Keep technical labels only when they help accuracy and are already familiar to the user.

## Implementation sequence

1. Rework Home hierarchy and copy.
2. Rework Send into a more guided flow.
3. Simplify Receive presentation.
4. Group Apps by intent.
5. Tighten Transaction History density.
6. Reorganize Settings into sections.
7. Normalize shared button and card hierarchy.

## Expected outcome

After these changes, the app should feel:

- easier to scan
- less crowded
- more task-oriented
- more confident in its primary actions
- less like a feature dump

## 2026-10-23 app-wide interaction review

Branch: `codex/ux-basics-and-workflow`; baseline `ac2da1cee`. Scope: shipped
React wallet routes and desktop wrapper, including `src/app/AppShell.tsx`,
settings configuration, connector dialogs and built-in apps. Compared hierarchy
with approved `docs/ui-overhaul/` references and existing components. These are
source-level findings and browser/test observations; they do not establish
packaged mobile or desktop evidence.

| Inventory area                                    | Review result                                                | Evidence and remaining gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Landing, create/import and watch-only onboarding  | Rendered on Android and Chrome                               | Android 34 and Chrome desktop-size onboarding rendered; disposable wallet creation exercised offline. Import/watch-only validation, cancellation and recovery phrase paths remain unexercised.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Wallet selection/switching and app shell          | Reviewed                                                     | Root handler and desktop picker routes inspected. Reopen, lock and switch need disposable-wallet exercise on both shells.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Home and portfolio                                | Offline freshness fix rendered                               | On Android 34 with networking disabled, Home explains that the balance could not be confirmed, offers Sync, and links to Server settings; the link opened the server panel. Freshness comes from the full network response, not the legacy initialized flag.                                                                                                                                                                                                                                                                                                                                                                |
| Assets, token details and UTXO actions            | BCH inventory rendered                                       | Empty BCH inventory, token/NFT counts and tabs rendered. Token detail, UTXO selection and freeze/reserve/retry behavior need fixture exercise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Receive, address selection, QR and sharing        | Packaged Android 34 controls measured                        | On the rebuilt Play Debug package with a disposable public-only watch-only wallet, “Copy address” is announced, includes a copy icon and measures 44px; address-type switch and Address/PubKey/PKH modes also measure 44px. Assets BCH/NFT tabs measure 44px. Native Toast had previously displayed “Address copied”; clipboard-preview screenshots are excluded because they expose the copied value. QR modes, share targets, expiry/invalid requests, multisig coordination and physical safe-area behavior remain unverified.                                                                                           |
| Send, scanner and transaction review              | Watch-only empty state and malformed BIP21 handling improved | Rebuilt Android 34 shows wallet-specific no-coins guidance; Build unsigned transaction is disabled with a visible reason. Shared BIP21 parser rejects malformed, duplicate, zero, and over-precision amounts; QR scan reports invalid payment requests without populating the recipient. Scanner notifications use the accessible shared fallback. No refresh, build, approval, signing or send was triggered. Scanner cancellation and full review/authorization remain open.                                                                                                                                              |
| Transaction history and details                   | Explorer, retry and label editing improved                   | Separate selected-explorer action, policy guidance, loading and retryable history/detail fetch failures. Transaction labels use an in-wallet editor with explicit Save/Cancel and accessible save errors; tests cover rejected detail lookup/retry and rejected label save. Populated pagination and native browser-open behavior remain gaps.                                                                                                                                                                                                                                                                              |
| Outbox and pending transaction recovery           | Touch targets improved; release lock remains guarded         | Sync, Copy transaction ID, and release actions now have 44px minimum targets. Existing regression confirms the Fusion verification lock stays disabled with its accessible reason; it now verifies all three targets. Retry/cancel/uncertain broadcast states need disposable transaction exercise.                                                                                                                                                                                                                                                                                                                         |
| Backup, recovery phrase, wallet info and app lock | Reviewed; Wallet Info feedback and targets improved          | Wallet Info errors announce once, save-name results announce status, and copy/rename/identity/recovery actions meet 44px minimum targets; copy uses only shared result feedback. Password/biometric gates remain intact. Secret reveal, cancellation and platform lock paths need exercise.                                                                                                                                                                                                                                                                                                                                 |
| Network, server and privacy settings              | Reconnect feedback and touch targets fixed                   | Rejected Electrum reconnects now appear as accessible alerts, successful connections are polite status announcements, and Auto/Manual/Connect actions have 44px minimum targets; regression exercises a rejected reconnect. Explorer policy tests pass.                                                                                                                                                                                                                                                                                                                                                                     | Network switching, custom explorer setup, packaged connection refusal and live recovery remain unverified |
| Multisig and hardware                             | Reviewed                                                     | Setup, receive, policy and cosigner copy feedback updated. Hardware connection, signing and recovery remain unverified on devices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| WalletConnect, CashConnect and WizardConnect      | Reviewed; WizardConnect transient feedback unified           | WizardConnect validation, pairing, scan, approve and reject outcomes now use the shared native-toast/browser-status presenter, so browser and desktop failures remain visible if native toast delivery is unavailable. Signing/pairing behavior is unchanged. Keyboard focus, expiry, approve/reject and mobile dialog stacking need integration exercise.                                                                                                                                                                                                                                                                  |
| Advanced tools and built-in apps                  | Reviewed; CashFusion touch targets fixed                     | Route inventory includes Quantumroot, CashFusion, contract tools, chat, Merchant Pay, Cauldron, FundMe, Airdrops, Paryon, MemoCash, Mint and paper-wallet sweep. CashFusion protocol-help and three mode toggles now have 44px-or-larger targets, covered by the CashFusion settings regression. Merchant Pay now offers Retry after pool loading fails; copy paths in Contract View, Watch Only, RPA, Quantumroot, Merchant Pay and Mint PoC report outcomes. Per-app retry/cancel/empty/error states still need fixture review.                                                                                           |
| Settings panels and desktop menus/dialogs         | Android categories and Connections panels rendered           | All three mobile settings categories and seven reachable Connections panels (Servers, Nostr & Chat, Merchant Pay, WalletConnect, WizardConnect, CashConnect, Experimental Features) opened on Android 34; no connection or publish action was activated. Nostr explains that native relay checks are unavailable. An ordinary Back action was incorrectly styled as danger; it now uses the secondary style, covered by a UI regression. Wallet/security and About subpanels were categorized; secret-reveal and platform-specific actions remain unexercised. Desktop menu and keyboard/focus traversal remain unverified. |

### Route, settings, menu and dialog coverage register

The register below maps every declared application route and settings panel to
the review above. “Source review” means interaction/state handling was inspected
in code; it does not claim rendered acceptance. Dynamic IDs and permissioned
flows require fixtures for their full states.

| Surface inventory                                                                                                                                                                                                                                                                                                                                                       | Coverage result                                                                                                                                                                                                                                                                                                                                                                                                                                  | Explicit verification gap                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry and wallet lifecycle: `/`, `/landing`, `/createwallet`, `/importwallet`, `/watch-only`; saved-wallet picker, open, lock, switch                                                                                                                                                                                                                                   | Android 34 and Chrome 1440px/390px onboarding rendered; browser creation preview counted without reading words and canceled; invalid import and watch-only recovery hints exercised; Chrome keyboard focus/Help checked                                                                                                                                                                                                                          | Valid import/derivation discovery, recovery-word backup confirmation, lock/unlock, wallet switching, password cancellation and file-picker errors remain unverified; no wallet was saved in the browser exercise                                                                                  |
| Wallet overview and holdings: `/home/:wallet_id`, `/assets`                                                                                                                                                                                                                                                                                                             | Android offline Home and empty Assets rendered; Home now announces manual refresh failures and retains a 44px Sync retry; offline freshness recovery link exercised; Assets local inventory errors have a localized alert and retryable read-only reload; transaction and UTXO personal labels use a shared in-wallet editor, with save error/retry and database failure regressions                                                             | Populated BCH/token/NFT/UTXO states, metadata loading/error, spendable vs reserved explanation, packaged Assets fallback failure, and label editing on a populated packaged UTXO screen still need fixtures; Home refresh failure lacks native fixture rendering                                  |
| Receive and payment requests: `/receive`, RPA receive, payment-request QR; multisig receive                                                                                                                                                                                                                                                                             | Rebuilt Android 34 package: Copy address has a clear accessible name/icon and 44px height; address switch and Address/PubKey/PKH tabs are 44px; native copy toast was exercised earlier. Empty-address preparation has single-flight loading, accessible failure feedback and retry control tests. BIP21 amount input now preserves pasted text, validates positive BCH precision, announces invalid input and prevents malformed QR/copy output | Packaged address-preparation failure and wallet-switch race exercise, QR scan/share target, expiry/invalid request beyond BIP21 amount, multisig coordination and physical safe-area behavior remain open                                                                                         |
| Send and review: `/send`, advanced `/transaction`, watch-only send, multisig send/sign                                                                                                                                                                                                                                                                                  | Android empty Send rendered; disabled Review explanation fixed; scanner controls are named and 44px in source; malformed BIP21 scan handling is tested; ordinary Back navigation now uses the secondary style and a 44px minimum; the Simple Send review dialog has keyboard containment and cancellation coverage                                                                                                                               | Android capture `android-send-empty-android34.png` predates the Back-style correction; scanner cancellation, valid review, invalid destination, fee/selection errors, hardware signing and broadcast outcomes require disposable fixtures; no transaction sent                                    |
| Transaction history/detail and outbox: `/transactions/:wallet_id`, legacy `/history/:wallet_id`, `/outbox`                                                                                                                                                                                                                                                              | Component tests cover separate detail/explorer actions, selected-network routing, policy refusal, detail fetch failure and retry; pagination controls and page-size selector have accessible names; Outbox verification lock includes a visible reason                                                                                                                                                                                           | Populated pagination/filter empty/error and pending/unknown/retry/cancel UI states need disposable transaction fixtures; native browser-open behavior also remains unverified                                                                                                                     |
| Multisig: `/multisig/setup`, `/multisig/:wallet_id` home, `/receive`, `/send`, `/sign`, `/policy`                                                                                                                                                                                                                                                                       | Setup, policy, receive and cosigner copy paths source-reviewed; cosigner PSBT QR scanner now uses the shared keyboard-accessible Popup with tested error and empty-result handling                                                                                                                                                                                                                                                               | Create/import coordination, signer threshold/incomplete signatures, real camera/image-file scanning, and device-sized dialogs remain unexercised                                                                                                                                                  |
| Settings panels (all 26): `appearance`, `recovery`, `about`, `terms`, `contact`, `contract`, `walletconnect`, `wizardconnect`, `cashconnect`, `merchant-pay`, `network`, `faucet`, `wallet-info`, `birthday`, `derivation`, `server`, `console`, `experimental`, `cashfusion`, `nostr`, `addons`, `language`, `app-lock`, `rebuild-wallet`, `export-archive`, `updates` | Source-reviewed all 26; Android rendered all three categories, Servers/Nostr/Merchant Pay/WalletConnect/WizardConnect/CashConnect/Experimental panels, and long Terms of Use content. Back navigation is secondary-styled and UI-tested. Derivation-path validation is now an announced alert associated with invalid fields; its primary actions have 44px minimum targets and completion/error feedback is announced.                          | Remaining panels, platform-specific controls, secret gates, failed saves and destructive confirmations need panel-level fixtures; desktop settings presentation remains unrendered                                                                                                                |
| Desktop menu: File, Wallet, View, Help; macOS Edit and Window                                                                                                                                                                                                                                                                                                           | Menu construction/actions and keyboard routing source-reviewed                                                                                                                                                                                                                                                                                                                                                                                   | Native menu interaction, menu-open failure, keyboard traversal and focus return require packaged desktop verification                                                                                                                                                                             |
| Dialogs: wallet confirm/address selection; transaction review/NFT config/details; WalletConnect, WizardConnect and CashConnect proposal/settings/sign/error/execute; multisig QR; contract/function; FundMe pledge/consolidate/detail; Quantumroot vault                                                                                                                | Shared Popup and WalletPopupSheet semantics and keyboard focus have component tests; Android BIP21 verifies packaged focus wrap/cancel/restore; address picker and multisig QR scanner loading/error/cancel/select paths have UI tests                                                                                                                                                                                                           | Live connector proposal resolution, nested/focus stacking, WizardConnect dialogs, transaction review/sign/cancel, QR paths on camera/image targets, notification stacking, and narrow/long-content device layouts need fixtures                                                                   |
| Built-in apps and advanced routes: `/apps`, `/apps/:appId`, `/apps/fundme` alias, `/campaign/:id`, `/paryon`, `/mint-cashtokens-poc`, `/paper-wallet-sweep`, `/quantumroot`, `/cashfusion`, `/contract`, `/chat`, `/chat/:conversationId`                                                                                                                               | Android rendered Apps, Quantumroot, Mint PoC, Paper Wallet and Contract; Contract View and installed add-on host failures have announced, tested 44px retry actions; Paper Wallet Sweep scan/build/broadcast errors are announced in-page and in its confirmation sheet; CashFusion falls back to Home without its capability. MemoCash pagination and copy paths have accessible feedback changes                                               | Per-app permission, funding, empty/loading/error, cancellation and retry states still need fixtures; packaged Contract/add-on retry, Paper Wallet Sweep error-in-sheet, Campaign, chat, marketplace host, RPA and app aliases not runtime-exercised; no app transaction was approved or broadcast |
| Reserved/unregistered path: `/qr-signing-demo`                                                                                                                                                                                                                                                                                                                          | Constant exists; no registered route found in `AppShell`                                                                                                                                                                                                                                                                                                                                                                                         | Confirm whether this is stale/dead route metadata; it is not reachable through the current router                                                                                                                                                                                                 |

### Additional cold-start finding

8. **Medium — cold start was visually blank while wallet modules initialized.**
   On a clean Android 34 profile, the launch image disappeared before the
   wallet UI was ready, leaving a blank surface for several seconds. Added an
   accessible, safe-area-aware “Starting wallet…” status directly to the HTML
   shell so it appears before the JavaScript module graph loads. Startup
   replaces it with the wallet or the existing retryable startup error. A
   focused DOM test covers status semantics and the decorative spinner; an
   Android 34 screenshot verifies the rendered message in the rebuilt package.

### Findings and corrections

1. **High — explorer action missing from transaction history.** Open
   Transactions and inspect a row: it opened details but offered no direct
   explorer action. Restored a separately labelled action per row and retained
   it in transaction details. It uses selected explorer/current network under
   shared policy. A blocked action explains the policy and links to Settings →
   Servers.
2. **Medium — copy had no dependable confirmation.** Copy the selected Receive
   address on mobile: clipboard could succeed without a visible response.
   Added a shared wrapper that checks clipboard success, requests native
   Capacitor Toast on mobile, and falls back to a safe-area positioned accessible
   status. It omits copied contents, replaces repeated messages, and does not
   turn notification failure into clipboard failure.
3. **Low — review preparation said “Sending…”.** Preparing a review could imply
   broadcast. The button now says “Preparing review…”; proposal construction,
   approval and broadcast behavior are unchanged.
4. **Low — migrated copy actions could show duplicate messages.** Removed local
   duplicate notifications and centralized outcome feedback.
5. **Low — initial history loading resembled an empty wallet.** The no-rows
   region now announces “Loading transaction history…” until the fetch ends,
   then shows the existing empty state if no activity exists.
6. **Medium — zero balance was ambiguous offline. Fixed.** Android 34 showed
   zero BCH and no recent activity offline without saying whether it had
   refreshed. A wallet-scoped freshness state now distinguishes complete
   network results from transport failures and incomplete per-address results.
   Cached coins remain available but are labelled stale or unverified. Home
   explains the uncertainty and links to Server settings. Spend authorization
   and transaction behavior are unchanged. Regressions cover current,
   unavailable, stale-cache and incomplete results.
7. **Low — disabled Review reason was hover-only. Fixed.** On the empty Android
   Send form, the disabled Review button exposed its reason only through `title`,
   which touch users cannot hover. It now explains “Fill the required fields
   first” beneath the action.
8. **Low — history pagination controls were not understandable to screen
   readers. Fixed.** The previous/next buttons only exposed `<` and `>`; the
   page-size selector had no accessible name, and the Sync button lost its name
   while showing a spinner. Added localized accessible labels, marked the
   spinner decorative, and raised pagination targets to 44px minimum.
9. **Low — Receive and Assets controls were below comfortable touch size.**
   Receive mode tabs were 38px and the receive-type switch was 24px high; Assets
   tabs also relied on text height. Increased their minimum interactive height
   to 44px. The address itself also appeared as an unlabeled 36px copy button,
   so the control now announces “Copy address,” shows a decorative copy icon,
   and has a 44px minimum height. Rebuilt Play Debug package measurements on
   Android 34 confirm 44px for the copy action, switch, all three address-mode
   tabs and BCH/NFT Assets tabs. No copied value was captured.
10. **Medium — Outbox recovery reason was hover-only and English-only. Fixed.**
    A Fusion transaction awaiting wallet verification showed “Awaiting
    verification” but explained the disabled release action only in a `title`.
    The explanation is now visible, connected with `aria-describedby`, and the
    status/reason use translation keys. A component test verifies the disabled
    state and its accessible description.

11. **Low — QR scan controls were hover-only and undersized. Fixed.** In Simple
    Send and the advanced BCH, CashToken and NFT transaction editors, camera
    buttons used `title` without an accessible name; the Simple Send target was
    42px and builder targets relied on icon padding. Added localized accessible
    names, decorative icon semantics, and explicit 44px minimum hit areas. This
    is source/type/lint verified; scanner permission, cancellation and camera
    behavior still need native interaction evidence.

12. **Low — settings Back navigation looked destructive. Fixed.** The Android
    settings walkthrough showed that returning from a settings category used
    the danger button style despite performing only navigation. It now uses the
    shared secondary action style; the Settings UI test asserts both the
    secondary style and absence of danger styling.

13. **Low — watch-only empty-coin recovery guidance named the wrong wallet
    type. Fixed.** In `/send` with the disposable offline watch-only wallet,
    the empty coin hint told users to refresh a multisig inventory. The shared
    send coordinator now selects watch-only or multisig wording from the loaded
    policy context. A focused test covers both variants, and the rebuilt Android
    package shows the correct wallet-specific message. No refresh, approval or
    transaction action was triggered by the invalid-recipient inspection.

14. **Low — CashFusion mode and protocol-help controls were too small for
    mobile use.** The protocol disclosure control used text padding only, and
    three switches rendered at 20–24px. They now provide 44px minimum height
    and comfortable width while preserving switch visuals and disabled states.
    A CashFusion settings regression verifies all three switch targets and the
    help target. Native CashFusion interaction remains unavailable with the
    current watch-only fixture, so packaged behavior is not claimed.

15. **Medium — Home refresh failures were invisible.** The manual refresh path
    logged network or history refresh failures and stopped the spinner without
    telling the user. Home now presents a localized alert, clears it on retry,
    and keeps the Sync action at a 44px minimum. The sync regression and
    translation resource checks cover the error hook-up; native failure-state
    rendering still needs a disposable network-failure fixture.

16. **Low — Build unsigned transaction stayed enabled with zero selected
    coins. Fixed.** In the offline watch-only `/send` view, after network
    refresh ended, the button became enabled although the coin list was empty;
    pressing it would only produce “Select at least one coin.” It now disables
    when no coin is selected and associates a visible explanation with the
    button. The focused availability regression covers empty, unselected, busy,
    and ready states. The rebuilt Android 34 package confirms the disabled
    button and reason; `android-watch-only-send-unguarded-build-before.png` and
    `android-watch-only-send-no-coins-android34.png` record before and after.

### Verification status and gaps

Explorer policy tests (10 cases), copy-feedback tests (7 cases), browser-open
tests (2 cases), and wallet-sync outcome tests pass. Copy
coverage includes clipboard failure, notification fallback without content
leakage, and repeated-message replacement/expiry. Source review confirms the
transaction network is passed to explorer resolution. A new rendered component
regression also verifies the history row's details action stays separate from
the explorer link, selected-network URL resolution, policy refusal guidance,
and the Settings link. An Outbox component regression verifies the pending
Fusion lock and accessible recovery explanation. The latest full React UI
suite passes 70 tests across 26 files; the current built-in-app suite passes
139 tests across 31 files; the broad core suite passes 1,993 tests across 307
files (10 tests and 7 files skipped). Current checkout typecheck, lint, standard
and desktop Vite builds, and focused formatting checks pass after the latest
UI changes.
Android 34 rendered
onboarding, Home, Assets, Actions, Apps, Send, and Settings → Server with a
disposable offline wallet. The rebuilt clean-profile app also showed the
accessible startup message before onboarding. The native Toast plugin logged
and displayed “Address copied”; Android's clipboard preview revealed the copied
address, so that capture was discarded. Safe screenshots are indexed in
`docs/ui-overhaul/evidence/`.
Chrome headless rendered current onboarding at 1440×1000 and 390×844 viewports.
The mobile browser buttons measured 48–50px high. The onboarding Help walkthrough
was opened and visually inspected. A Tab press focused the Language selector
with a visible 4px green focus ring. Browser interaction counted the generated
12 recovery-word rows without reading their contents, then canceled; invalid
12-word import showed an alert; watch-only missing-name and missing-xPub actions
showed recovery guidance. No wallet was saved. Safe screenshots are
`browser-onboarding-final-chrome.png`, `browser-onboarding-mobile-chrome.png`
and `browser-help-final-chrome.png`. The first Android startup exposed
synchronous WASM compile/instantiate on the main thread; async preparation now
precedes React shell import.

Final source revision onboarding was rendered again on the dedicated Android 34
CodexUX emulator after rebuilding/installing `assemblePlayDebug`; the safe
capture is `android-onboarding-final-android34.png`. The launch reached the
wallet creation screen, but its generated recovery phrase appeared in a
temporary inspection image. The image was removed and app data cleared before
any wallet was saved. That fixture was discarded; no phrase is retained in the
evidence directory. This does not count as creation/recovery-flow verification.

The desktop React wallet screens and packaged iOS UI, native Toast layering
above dialogs, desktop keyboard/focus traversal, and disposable-fixture exercise
of every route's loading, empty, error, cancellation and retry states remain
open. Chrome headless proves desktop-size rendering only, not interactive desktop
acceptance. No signing, broadcast or mainnet operation was performed. Latest
Receive/Assets target measurements were taken in the rebuilt Android 34 package
using a disposable watch-only wallet derived from a public-only test fixture;
it had no private key or funds. The Receive copy action was not tapped during
this final measurement, so no Android clipboard preview was created.
The continued route/settings walkthrough is documented in the requirement
ledger. Its safe current-package captures are
`android-settings-categories-android34.png` and
`android-settings-back-secondary-android34.png`.

12. **Medium — BIP21 QR used a duplicated mainnet address prefix.** On
    Receive, open BIP21 with the normal `bitcoincash:` address. The old builder
    prepended `bitcoincash:` without removing the prefix already present on the
    selected CashAddr, producing `bitcoincash:bitcoincash:...`. The payment URI
    now removes only that duplicate mainnet prefix and preserves test-network
    prefixes. Four focused tests cover mainnet, testnet, optional encoded
    fields, and a missing address. This follows the
    [CashAddr payment URL double-prefix rule](https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md#double-prefix).
13. **Low — BIP21 form controls lacked accessible names and comfortable touch
    size.** In the previously installed Android package, Amount, Label and
    Message each had no associated `<label>` and measured 42px; Clear measured
    16px. The current Play Debug package now measures all fields and Clear at
    44px, with one associated label per field. Copy BIP21 is also 44px. Escape
    closes the dialog. The helper and form have focused unit coverage and the
    packaged dialog was exercised with an offline public-only watch-only wallet;
    no URI/address was copied or captured.

The latest packaged Receive verification is bounded to BIP21 form semantics,
labels, target sizes and cancellation. It does not verify QR decoding,
external share targets, request expiry, multisig coordination or physical safe
areas. The complete route and settings inventory above retains per-surface
verification gaps; source review alone is not represented as packaged
acceptance.

14. **Medium — shared popups were not exposed or dismissed as dialogs.** The
    Receive BIP21 form and other screens use the shared `Popup`, which had no
    dialog semantics or Escape handler; keyboard users could only locate the
    visible Close action. The shared shell now sets `role="dialog"` and
    `aria-modal="true"`, and Escape invokes the existing close callback. The
    Close control is an explicit button. The focused Popup regression asserts
    modal semantics; Android 34 package verification confirms the BIP21 dialog
    attributes, the three labeled 44px fields, and Escape dismissal. Focus
    containment/restoration are now covered below; nested dialog interaction
    remains to be verified.

15. **Medium — shared Popup keyboard focus was not contained or restored.**
    With the Receive BIP21 dialog open, keyboard focus previously had no shared
    modal boundary. Popup now moves focus to the first available control (falling
    back to Close), wraps Tab and
    Shift+Tab within its focusable controls, restores focus to the previously
    active trigger on close, and retains Escape dismissal. A jsdom interaction
    regression covers focus entry, both wrap boundaries, Escape and restoration.
    The rebuilt Android 34 WebView confirms the first-input reverse wrap to
    Close, forward wrap from Close to Amount, Escape dismissal, and focus return
    to the BIP21 trigger. Screen-reader and hardware-keyboard behavior on
    physical devices, plus nested modal stacking, still need platform checks.

16. **Low — generic popup dismissal looked destructive.** Popup's default Close
    control used the danger-button style even though it only dismissed the
    dialog. It now uses the shared secondary style. Initial focus moves to the
    first available dialog control (or Close if there is none), so the BIP21
    amount field is immediately ready for keyboard entry. Static and interaction
    regressions cover the neutral style and focus behavior; the rebuilt Android
    package confirms initial focus on Amount and the secondary Close class.

The popup focus effect uses the latest close callback without restarting focus
management on ordinary parent rerenders; otherwise typing into a controlled
field could return focus to the trigger. The interaction test rerenders the
component with a new callback and confirms the active control remains focused.

17. **Low — connector dismissal looked like a neutral close while rejecting.**
    WalletConnect and CashConnect proposal/action sheets used a Close button
    and backdrop/Escape dismissal that invoked their Reject handler, alongside
    a separate Reject action. The sheet now lets decision dialogs label that
    dismiss control “Reject” (WalletConnect uses its localized label); error
    sheets retain “Close.” The component exposes keyboard focus containment,
    restoration and an updated-callback path. Component interaction tests cover
    those behaviors and explicit rejection labeling. A live connector peer and
    proposal fixture are still needed to verify end-to-end request resolution.

18. **Medium — contract address picker hid loading and lookup failures.** In
    Contract and contract-function flows, saved addresses were loaded in an
    effect; failures only wrote to the console, while an empty list looked like
    a blank dialog. Replaced the custom shell with the shared accessible Popup,
    changed Back from danger to secondary styling, and added a loading status,
    explicit empty state, retryable error, named address buttons and 44px
    targets. Three UI regressions cover loading/selection, empty state and
    failure/retry recovery. The Android package rebuilt, but its offline
    watch-only fixture exposed no contract templates on `/contract`, so the
    address-picker flow could not be opened. A disposable contract fixture is
    still needed for packaged review.

19. **Medium — Assets hid failures in its fallback inventory read.** The
    screen passed a wallet-data error setter to `useFetchWalletData` but ignored
    its state, so a failed local address/UTXO database read could leave the
    inventory looking empty. Assets now shows a localized alert and a 44px
    Retry button. The retry increments an explicit request key to repeat the
    same database read; it does not trigger network sync. The hook clears the
    prior error before retry and clears stale error state when the read is no
    longer needed. A focused hook regression covers failure, error clearing and
    retry success. The Android package path needs a disposable database-failure
    fixture for rendered proof.

20. **Medium — Contract View load errors had no recovery action.** Failed
    artifact or instance reads replaced the route with an empty state, so users
    could not retry without navigating away and back. The error view now
    announces the failure and offers a 44px retry that reruns the contract
    loads. A UI regression covers the alert and retry action; packaged retry
    still needs a disposable contract fixture with templates.

21. **Low — Wallet Info copy/status controls were inconsistent and undersized.**
    Copy rows added a local “Copied” label on top of shared feedback and
    swallowed clipboard failures; they now rely on the shared result-aware
    presenter, use accessible copy labels, and provide 44px targets. Wallet
    identity, rename, save/cancel and recovery actions now also meet 44px; the
    error and name-result messages use alert/status semantics. Security gates
    and secret display behavior are unchanged. Secret interaction still needs
    packaged password/biometric verification.

22. **Medium — Paper Wallet Sweep broadcast errors appeared behind confirmation.**
    If sending failed, the confirmation sheet remained open but the error was
    only rendered on the page behind it. The error is now announced inside the
    sheet and in the page when applicable. Scan/Sweep controls have 44px minimum
    targets, and Back uses secondary styling. The error-notice UI regression
    passes; packaged broadcast-failure behavior remains unverified because it
    needs a disposable paper-wallet fixture and must not broadcast funds.

23. **Medium — Receive address preparation gave no progress or recovery.**
    Bootstrap errors were only logged, the Prepare control stayed enabled during
    derivation, and an empty result appeared successful. Receive now prevents
    duplicate initialization, announces progress, treats an empty result as a
    failure, and offers a localized alert with a 44px retry action in both
    empty-address layouts. Wallet changes clear previous addresses and cancel
    in-flight lookup results; explicit initialization checks the active wallet
    before publishing keys. Focused UI and resource checks cover busy/error
    feedback; packaged failure and wallet-switch interaction remain unverified.

24. **Low — Server connection outcomes were not announced accessibly.**
    Reconnect errors and success messages were visible but lacked alert/status
    semantics, and Auto/Manual/Connect targets had no 44px minimum. Added those
    semantics and target sizes; the settings regression forces a rejected
    reconnect and checks the alert. Packaged network refusal and custom-server
    recovery still need runtime verification.

25. **Medium — Transaction detail fetch failures had no retry.** The detail
    popup showed fetch errors as muted text without an announcement or recovery
    action. It now exposes the failure as an alert and retries a force-refreshed
    lookup for the same transaction through a 44px action. A UI regression
    rejects the first lookup and verifies the retry. Populated details and
    native explorer opening still need disposable transaction/runtime evidence.

26. **Low — Personal labels relied on the browser prompt and hid storage
    failures.** Transaction and UTXO labels now share an in-wallet editor with
    explicit Save/Cancel, a 200-character limit, a save-in-progress state and
    an accessible save-failure alert. A UI regression checks editor failure
    and retry; the coin-label service regression checks that database write
    failures propagate rather than reporting false success. A populated UTXO
    screen and packaged native rendering remain unverified.
27. **Medium — WizardConnect transient feedback depended on native Toast.**
    URI validation, scan results, pairing, and transaction approval/rejection
    used direct native-toast calls, leaving browser/desktop without a visible
    fallback. These paths now use the shared presenter, which prefers native
    Toast and falls back to an accessible wallet status. Focused notification
    and WizardConnect UI tests verify native delivery and fallback; packaged
    connector resolution and dialog stacking still need fixtures.
28. **Medium — BIP21 amount entry could silently change pasted values.** The
    Receive handler stripped unsupported characters, so a value such as
    `1e-3` could be changed to `13` without explanation. The field now keeps
    the entered text, validates positive BCH amounts to eight decimal places,
    accepts a single locale comma, announces invalid input, and disables copy
    and payment QR output until corrected. Focused tests cover valid precision,
    zero, malformed/scientific notation, excess precision and locale input; the
    Arabic validation message is translated. Packaged keyboard/paste behavior
    remains unverified.
29. **Medium — scanned BIP21 amounts accepted numeric prefixes.** Send's
    parser used `parseFloat`, which accepted values such as `1e-3` and `13abc`
    as amounts and ignored duplicate amount parameters. The shared parser now
    requires a positive decimal with at most eight places and flags malformed,
    zero, and duplicate values. The scanner shows a localized recovery message
    and leaves the recipient unchanged when the request amount is invalid;
    scanner notices also use the shared native/browser presenter. Focused
    parser regressions cover these cases. Packaged camera scanning and valid
    review remain fixture gaps.
30. **Low — Outbox recovery actions were undersized for touch.** Sync, Copy
    transaction ID, and release controls had no explicit 44px minimum. They
    now meet that target; the Outbox UI regression verifies target classes and
    confirms a verification-locked Fusion release remains unavailable with an
    accessible explanation. Populated retry/cancel/uncertain broadcast flows
    still require disposable transaction fixtures.
31. **Medium — transaction review was not keyboard-contained.** The custom
    review modal had dialog semantics but no accessible name, initial focus,
    Escape cancellation, focus trap or restoration. It now provides those
    behaviors and a 44px Close action; Escape cannot close during an active
    send. The focused UI regression verifies the accessible name, focus
    boundaries, cancellation, focus return, and that Escape never triggers
    confirmation. A full transaction review/approval fixture remains
    unexercised.
32. **Medium — multisig QR scanning used an uncontained custom dialog.** The
    cosigner scanner had no accessible name or shared keyboard focus behavior.
    It now uses the wallet Popup, with a 44px scan action, announced failures,
    retry, and safe empty-result handling. UI regressions verify dialog naming,
    initial focus, scanner failure feedback, retry availability, and that
    cancellation/empty results never pass a frame to the cosigner flow. Actual
    camera and desktop image scanning still need platform fixtures.
33. **Medium — installed add-on failures had no recovery action.** Bundle
    reads and sandbox initialization could leave the app on a red error block
    without an accessible announcement or retry. The host now exposes the
    failure as an alert and retries by tearing down/reloading the sandbox from
    the installed bundle source, with a 44px Retry action. UI regressions cover
    both bundle-read and iframe-initialization failures and recovery; this does
    not change add-on permissions. A packaged installed add-on fixture remains
    unverified.
34. **Medium — Merchant Pay pool errors had no retry action.** The quote status
    asked the user to try again but pool fetching only retriggered on network or
    stablecoin changes. A localized Retry action now starts another pool fetch;
    it does not create a payment request. A mounted hook regression now verifies
    error, retry, and second-fetch behavior; full app rendering and platform
    verification remain outstanding.
35. **Medium — derivation path errors were not announced or connected to the
    disabled resync action.** Invalid coin type/account index appeared as plain
    red text. The field now announces the validation alert and points both
    inputs and the disabled Change and resync action to it; success/no-op
    feedback uses a status announcement. The principal controls meet the 44px
    touch target. UI regression verifies invalid state semantics and the field
    relationship; confirmation, persistence failure, scan and native behavior
    still need fixtures.
36. **Low — ordinary Send navigation was styled as a destructive action.** In
    the Android empty-Send capture, Back was red despite only navigating to the
    previous wallet screen. It now uses the secondary style with a 44px minimum
    target. The capture is retained as pre-fix evidence; a fresh native render
    could not be made because no Android device/emulator is attached. No send or
    transaction behavior changed.

## Screenshot-led assessment — 2026-10-23

This assessment uses the temporary capture pack at
`/run/user/1000/optn-ux-review-20261023/`. Images, the local HTML gallery,
contact sheets, detailed findings/acceptance checks, and per-surface gaps stay
in tmpfs under `analysis/`; no new screenshot is stored in the repository.
The evidence was compared with the canonical UI/UX skill and approved Home,
Send, Receive and Cauldron references. This is an assessment, not a claim that
the following recommendations are implemented.

### Evidence correction

The pack's original completion report overstated coverage. Of 42 PNGs, 13
allowlisted frames show 11 distinct, partially captured surfaces. Twenty-three
are immediate startup frames; three transaction/settings-labelled files
actually show Home. Eleven originals are **780×493**, including several
previously described as mobile. CSS viewport/DPR/build configuration and the
original dirty source fingerprint were not recorded. Loaded 1440×900 evidence
exists only for onboarding. No packaged Android/Tauri evidence is present in
this pack; older native evidence above remains historical.

The claimed Chipnet fixture is unsupported: captured Settings reads Mainnet,
and the inspected creation flow defaults to Mainnet. No network switch was
recorded. The approved private-key behavior is the **intentional 10-tap process
with a masked display**. Do not replace it with a full-key text reveal. The
existing rapid-click captures do not prove the selected mode or sequential
gesture; an unapproved intermediate synthetic reveal capture is excluded from
the analysis gallery. The raw pack must not be distributed or its fixture
reused.

The source-inspection context is HEAD
`ac2da1ceec73c8cd457e44fdfe02035cb034a173` plus uncommitted changes on
`codex/ux-basics-and-workflow`. Hashes of inspected source files are recorded
in the temporary `analysis/analysis-context.json`; they do not establish the
source fingerprint at capture time. No application source changed during
this assessment.

### Prioritized recommendations

P1 materially impedes a core task or omits important wallet context. P2 causes
avoidable confusion/effort. Observations below are browser evidence, with
source findings explicitly identified.

| ID    | Priority | Finding and evidence                                                                                                                                                                                                                                       | Proposed correction / acceptance                                                                                                                                                                                                                      |
| ----- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UX-01 | P1       | At 780×493, `authenticated-send.png` hides recipient/amount, `authenticated-receive.png` hides QR/address, and Assets/Settings retain secondary controls over their content. Shared header and constrained flex/scroll regions are candidate contributors. | Reduce nonessential compact-window header space and prevent footer/secondary controls from collapsing the main task. Reproduce with DOM measurements and verify scrolling, keyboard, zoom and native keyboard-reduced viewports; retain 44px targets. |
| UX-02 | P1       | Source-confirmed: `InfoTooltipIcon.tsx` returns `null`, discarding the recovery-phrase warning passed by Create, plus Import/network help.                                                                                                                 | Render accessible optional help and keep essential recovery guidance inline. Verify content, keyboard/touch and cancellation without recording recovery words. A new backup gate would be a separate product behavior change.                         |
| UX-03 | P1       | Apps/Outbox navigation uses white labels over light green. Adjacent captured pixels give about 2.02:1 against white; other gradient positions are lower.                                                                                                   | Correct existing foreground/background tokens and measure rendered active/inactive/focus and translated states. This is a contrast finding, not a complete accessibility certification.                                                               |
| UX-04 | P1       | Home lacks visible active-network context; shared `PageHeader` hides supplied titles/subtitles with `sr-only`. A Sync action is not a readiness label.                                                                                                     | Show a compact task title and canonical network/freshness status as in the approved references. Never infer readiness from zero balance or provider HTTP health.                                                                                      |
| UX-05 | P2       | Home places a BTC/USD ticker before BCH portfolio and quick actions, particularly costly in the short-window capture.                                                                                                                                      | Lead with wallet balance/status and Receive/Send. Put unrelated market data lower or in an optional view; preserve existing wallet actions.                                                                                                           |
| UX-06 | P2       | Source-confirmed: Simple Send includes coin control/change settings by default and puts the Airdrops app alongside asset choices. The form capture is cropped.                                                                                             | Use the approved More options pattern for advanced settings and a secondary destination for sending to many. Preserve transaction construction, selection and authorization.                                                                          |
| UX-07 | P2       | The landing heading leads with covenants; initial Create/Import/Watch-Only choices lack task explanations.                                                                                                                                                 | Explain create, restore and public-only viewing in plain language while retaining current routes and button hierarchy.                                                                                                                                |
| UX-08 | P2       | Create/Import put a large logo and derivation controls before the recovery task; Watch-only's xPub field is below the short-window fold.                                                                                                                   | Reduce decorative height, keep network choice explicit, and disclose custom derivation under advanced setup without changing defaults or import compatibility.                                                                                        |
| UX-09 | P2       | Receive and Outbox Back controls are red; Send Back is secondary. Source callbacks only navigate.                                                                                                                                                          | Use secondary navigation styling and reserve red for consequential actions. Retain the approved 10-tap/masked-key workflow and explicit copy feedback.                                                                                                |
| UX-10 | P2       | Apps clips Advanced horizontally at 390px and leads with demanding tools.                                                                                                                                                                                  | Make categories fully discoverable and prioritize task explanations within the existing catalog; preserve all apps and capability restrictions. Validate long labels and keyboard/touch.                                                              |
| UX-11 | P2       | Settings pins Log Out while configuration scrolls into a small area; Pending Tx Locks is technical shorthand.                                                                                                                                              | First fix content height, then reduce exit prominence and clarify pending-transaction labels. Keep existing groups and the approved Network destination.                                                                                              |
| UX-12 | P2       | Empty Outbox says sends are paused while reporting no pending transactions; source renders the explanation unconditionally.                                                                                                                                | Match empty/pending/unknown/reconciling guidance to actual state. Local release/removal must not imply reversal of an on-chain payment.                                                                                                               |

### Implementation status — 2026-10-23

The screenshot-led corrections are now implemented on
`codex/ux-basics-and-workflow`:

- **UX-01:** compact-height wallet pages reduce header/logo footprint while
  retaining scroll regions and 44px controls.
- **UX-02:** `InfoTooltipIcon` now renders keyboard/touch-accessible contextual
  help without exposing recovery material by default.
- **UX-03:** light-theme navigation uses a dark foreground token against its
  bright green gradient.
- **UX-04:** shared page headers show the task title; Home always identifies
  Mainnet or Chipnet and marks browser-viewer mode.
- **UX-05:** Home leads with portfolio and Receive/Send actions; price data is
  below recent activity.
- **UX-06:** Send places coin control and change-address settings behind an
  Advanced disclosure and gives Airdrops a secondary full-width destination.
- **UX-07:** onboarding uses plain wallet language and a short getting-started
  explanation while retaining the existing routes and help panel.
- **UX-08:** onboarding artwork is shorter on Create/Import/Watch-Only cards;
  custom derivation is behind an explicit disclosure and network selection stays
  visible.
- **UX-09:** Receive and Outbox navigation uses the secondary hierarchy; the
  approved ten-tap, masked private-key flow remains unchanged.
- **UX-10:** Apps category controls wrap at narrow widths so Advanced remains
  discoverable without removing any app or capability restriction.
- **UX-11:** Settings logout and back navigation are secondary until the
  wallet-owned confirmation; the pending-outgoing label is plain language.
- **UX-12:** Outbox only describes pending-send reconciliation when records
  exist; the empty state now reports no pending transactions without implying a
  pause.

Focused UI regressions (43 tests), full TypeScript, formatting, standard React
build, desktop React build and `git diff --check` pass. Rendered mobile/native
captures for these post-fix states remain a verification gap because no Android
device or emulator is attached; the temporary pre-fix capture pack remains in
tmpfs and is not a release artifact.

### Startup loading correction — 2026-10-24

Reported issue: startup remained on a white loading surface while the shared
Rust core, security WASM and AppShell module initialized. The web fallback now
uses the persisted theme before React mounts, a branded wallet card, and phase
labels. Capacitor no longer auto-hides its splash on a fixed timer or uses a
white background; the native splash remains until React is ready. Browser and
native failure paths still expose retry/hide behavior. Native packaged timing
and theme verification remain pending without an attached device or emulator.

### Coverage and next evidence

The temporary `analysis/coverage.md` maps the entire inventory above, including
all 26 settings panels, menu/dialog families and built-in apps, to partial
captures or explicit gaps. Current-pack useful evidence covers landing,
Create/Import/Watch-Only forms, empty Home/Assets, Receive, empty Send, Settings
root, Apps catalog and empty Outbox. History/detail/explorer, individual
settings panels, wallet switching, multisig/hardware, connectors, transaction
review/cancel, populated tokens/UTXOs and every built-in app workflow remain
unverified in this pack. No post-copy/native-toast sequence was captured.

Do not infer missing startup recovery from an immediate spinner: `main.tsx`
already renders an error/Retry path on startup rejection. A hanging
initialization is an untested hypothesis. Likewise, an Apps catalog or empty
Assets capture cannot prove Cauldron pool/transaction freshness or BCMR health.

Next: verified disposable Chipnet fixtures; settled route/query assertions;
true 390×844, 412×915, 780×493 and 1440×900 captures with secret/QR redaction
before saving; action → feedback → cancel/return sequences for copy, explorer,
Send/Review and Cauldron; then packaged desktop/native keyboard/touch/status
verification. Keep new images temporary and match each claim to its platform.

## Transaction preview review — 2026-10-24

Scope: regular BCH/FT/NFT Send, custom transactions, watch-only/multisig,
WalletConnect, WizardConnect, CashConnect, and the transaction surfaces reached
through Apps, with particular attention to Cauldron. This is an assessment;
the recommendations below are not implemented or product-approved changes to
authorization. Application code and existing dirty changes were preserved.

Reviewed the canonical skill and supplied `L_send_bch.png`,
`M_send_cashtoken.png`, and `P_cauldron_review.png` references. The Cauldron
reference already specifies the desired hierarchy: pay/receive, minimum receive,
slippage and fees, with transaction/route information under Technical details.

### Evidence and coverage

HEAD `ac2da1ceec73c8cd457e44fdfe02035cb034a173`, branch
`codex/ux-basics-and-workflow`, plus uncommitted changes. A temporary receipt
records SHA-256 hashes for 31 inspected source/reference files and the disposable
diagnostic fixture under `/run/user/1000/optn-tx-preview-review-20261024/`
(verified tmpfs). No new screenshots or wallet data were retained in the repo.

Evidence labels below distinguish **source** inspection, **component** exercises
in jsdom, and **gap** states. The browser inventory was empty and opening an
in-app tab returned `Browser is not available: iab`; no new browser layout,
touch, packaged desktop, Android or iOS evidence is claimed. No real wallet
approval, signing, or broadcast was performed; signing tests use synthetic keys.

| Surface / route                                                 | Review result                                                                                                                                                                                                                                                                                                | Verification gap                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `/send`: BCH, FT, NFT, RPA, hardware                            | Source: summary-first ReviewCard is the strongest existing pattern, with collapsed technical details and focus containment. Component: drag-only submission reproduced. NFT identity and hardware pending-state gaps below.                                                                                  | Full Send → Review → cancel/retry, live hardware, small-window layout and native touch.                    |
| `/transaction`: regular, NFT, FT, OP_RETURN and contract setups | Source: Build opens raw input/output details; after closing them, Send opens a second warning/drag dialog without the amounts or recipients.                                                                                                                                                                 | Disposable custom/contract/burn fixture and packaged execution.                                            |
| Watch-only and multisig Send/sign/broadcast                     | Source: retains unsigned → signer → verified signed result → broadcast steps. Component: multisig Total BCH includes returned change.                                                                                                                                                                        | Actual QR round trip and each device's approval UI.                                                        |
| WalletConnect request popup                                     | Component: wrong Chipnet prefix, missing-source approval enabled, and blank input identifiers reproduced. Source: raw totals replace wallet effects; Sign/Broadcast Yes/No does not explain the next action.                                                                                                 | Live peer, expiry, rejection/retry, hardware return and browser/device layout.                             |
| WizardConnect request popup                                     | Component: valid NFT preview omits capability/commitment. Existing tests confirm decode failures disable Sign. Source: raw inputs/outputs dominate and broadcast flag is disconnected from the adapter's sign-only result.                                                                                   | Live peer and hardware/device paths.                                                                       |
| CashConnect action popup                                        | Source: balance deltas are useful, but tokens are raw units/category fragments; `response.transactions` is unused. Approval releases the prepared response to the app.                                                                                                                                       | Live multi-transaction/template action, NFT and no-balance-change cases.                                   |
| Cauldron swap and quote details                                 | Source: extra Get Quote → details → close → Review → swipe path; final ordinary-swap review lacks fees, while route/normal-risk detail is expanded.                                                                                                                                                          | Built quote, stale/requote/failure interactions and fresh screenshots.                                     |
| Cauldron pool create/withdraw                                   | Source: create review has BCH/token/fee rows. Active withdrawal confirms reserves before building and estimating the transaction fee. A separate withdraw branch in `poolReview` does not drive the active withdrawal CTA.                                                                                   | Both operations, changed reserves, ownership and fee funding with disposable fixtures.                     |
| Merchant Pay → Cauldron payment                                 | Source: customer/merchant roles are clearer than a generic connector, but Total from wallet is gross funding, not net debit, and omits the token debit from its total. Merchant Pay itself creates/monitors requests rather than signing the customer's transfer.                                            | Customer handoff, expiry and successful/ambiguous submission.                                              |
| Mint CashTokens / category bootstrap                            | Source + component: generic TxSummary preserves BCH backing/fee but discards token amount/category/NFT authority and commitment.                                                                                                                                                                             | Metadata-unavailable, minting-authority and multi-output device review.                                    |
| Airdrops distribution                                           | Source: optional raw transaction review and separate final swipe; final total uses raw satoshi/atom amounts labelled BCH/Token. Confirmation rebuilds the transaction.                                                                                                                                       | Decimal-aware final review, large batch, stale funding and changed-fee handling.                           |
| Paper-wallet sweep                                              | Source: canonical `/paper-wallet-sweep` final sheet shows input/output counts, not destination, amount or fee. The app alias redirects to that route; the older duplicate app implementation is not counted as another active route.                                                                         | Disposable sweep fixture; no private-key entry or exposure during this review.                             |
| Paryon borrow/stake/redeem                                      | Source: action-specific metrics exist, warnings repeat in header/body, and the shared confirmation lacks pending/error recovery. Redeem's confirmation currently stages a preview rather than broadcasting.                                                                                                  | Native state-dependent readiness, live contracts and packaged flows.                                       |
| FundMe current add-on + legacy campaign detail                  | Source: current action buttons call build/sign/broadcast helpers without a transaction-specific review. Legacy campaign route has distinct pledge/consolidation dialogs. Do not merge these with Flipstarter.                                                                                                | Contract readiness and live execution; source reachability does not prove these WIP paths can transact.    |
| AuthGuard and installed iframe apps                             | Source: AuthGuard has separate mint/broadcast actions and build-only raw hex, rather than one consistent review. The SDK capability-consent UI is not a transaction preview; `confirmSensitiveAction` accepts only title/description/risk, not a verified transaction. MemoCash Reader has no spend preview. | Per-app proposal/approval fixtures and installed guest; no claim of host-owned transaction preview parity. |

### Prioritized findings

1. **TX-01 — P1: connector requests do not explain the user's wallet effect.**
   Open WalletConnect/WizardConnect with wallet and counterparty/contract inputs.
   Their total input/output rows include everybody's coins; neither separates
   payment, change, wallet token/NFT changes, or fee contribution. CashConnect
   supplies wallet balance deltas but renders raw token atoms and ignores its
   transaction list. Proposed: one wallet-owned review presentation fed by a
   verified plan, identifying requester, source wallet/network, assets leaving
   and returning, recipients/contract action, fees and operation semantics.
   Keep full inputs/outputs accessible under Technical details. Unknown
   ownership/fees must remain unknown, not guessed from the app prompt.
   Sources: `components/walletconnect/SignTransactionModal.tsx:109`,
   `components/wizardconnect/WizardSignTransactionModal.tsx:70`,
   `components/cashconnect/CashConnectExecuteActionModal.tsx:82` (under `src/`).

2. **TX-02 — P1, component-reproduced: WalletConnect mislabels Chipnet outputs.**
   Supply a Chipnet P2PKH transaction; expand Outputs. Preview uses
   `toCashAddress(lockingBytecode, 'bitcoincash')`, even while signing uses the
   wallet network. Proposed: consume validated request/wallet network and show
   Chipnet explicitly in the review. No change to chain selection is implied.
   Source: `src/components/walletconnect/SignTransactionModal.tsx:334`.

3. **TX-03 — P1, component-reproduced: incomplete WalletConnect preview can look approvable.**
   With one input and no source outputs, Sign is enabled and the fee is negative.
   Expanding input details also dereferences a missing source. With the valid
   source-output shape used by the existing signing test, input txid/index are
   blank because this UI reads them from source outputs rather than tx.inputs.
   Proposed: validate/normalize before rendering, display a recoverable invalid
   request state, and gate approval on a complete preview. Existing signer
   validation rejects a mismatched source count; this finding does not prove a
   malformed request can spend. Source: same modal, lines 109, 275, 421;
   reference fixture: `src/redux/walletconnect/__tests__/signing.rust.test.ts:57`.

4. **TX-04 — P1: approval, signature delivery and broadcast are conflated.**
   WalletConnect can sign-only or attempt broadcast; the hardware branch returns
   before its broadcast block, and software broadcast failures are caught while
   returning signed bytes. Wizard's preview displays the payload broadcast flag,
   but its adapter returns a signature without broadcasting. CashConnect's
   installed SDK hands prepared transactions to the app after approval. Proposed:
   distinct labels/statuses for “Sign transaction” versus “Sign and send,” and
   explain that a signed transaction returned to an app may later be broadcast
   by it. Report signature-delivery and broadcast outcomes separately. Do not
   add a broadcast side effect to make the UI text true.
   Sources: `src/redux/walletconnect/signing.ts:82,232`,
   `src/services/wizardconnect/OptnWizardWalletAdapter.ts:122`,
   `src/state/slices/wizardconnectSlice.ts:142`,
   `src/services/cashconnect/CashConnectService.ts:159,292` and installed
   `@cashconnect-js/nostr/build/lib/wallet/wallet.js:261`.

5. **TX-05 — P1, component-reproduced: NFT authority/identity disappears in final reviews.**
   A Wizard minting NFT renders its category and zero fungible amount, but neither
   minting authority nor commitment. Mint's `asTxSummaryOutputs` drops this
   information before TxSummary; the ordinary NFT Send summary also lacks the
   selected commitment/capability. Proposed: retain category identity, NFT
   commitment/identity and capability in the verified view model, with prominent
   mint/burn/authority-change consequences and optional full hex. These are
   decision-critical details, not merely technical rows.

6. **TX-06 — P1, component-reproduced: incorrect meaning of Total BCH / Total from wallet.**
   MultisigBroadcastReview passes `inputSumSats` as `totalSats`: fixture input
   100,000 sats, recipient 10,000, fee 100, change 89,900 displays total 0.001 BCH
   instead of 0.000101 BCH leaving the wallet. Merchant Cauldron's
   `merchantEstimatedWalletDebitSats` similarly sums gross funding inputs;
   “Additional BCH input” is also gross funding, and the final total ignores
   token debit. Proposed: use exact net wallet effects and show funding/change
   separately. Sources: `src/features/multisig/MultisigBroadcastReview.tsx:90`,
   `src/pages/apps/cauldron/CauldronSwapApp.tsx:2998,3010,6837`.

7. **TX-07 — P1, component-reproduced: confirmation requires dragging.**
   Simple Send/custom/App confirm handles are divs without keyboard handlers,
   slider semantics or equivalent confirm control. Send's dialog focus trap
   reaches Close/Technical details but not confirmation. The shared app modal
   also lacks initial focus, focus containment/restoration and Escape handling;
   its close target is only 36px. Proposed: one accessible deliberate-confirmation
   pattern preserving explicit authorization, with keyboard/screen-reader
   operation and comfortable touch targets. Reuse the existing focus behavior,
   rather than three unrelated implementations.
   Sources: `ReviewCard.tsx:672`, `TransactionActions.tsx:127`,
   `src/pages/apps/mint-cashtokens-poc/components/uiPrimitives.tsx:171`.

8. **TX-08 — P1: final custom/app reviews omit decision-critical costs/state.**
   Custom Build opens raw details, then Send presents warnings/swipe without a
   payment summary. Its builder explicitly enables implicit FT burn, but the
   final confirmation has no token-loss summary. Airdrops final swipe shows a sum
   of atomic job amounts labelled BCH/Token; e.g. a 1,000-sat BCH job reads total
   1000 BCH. Sweep final review provides counts without amounts/destination/fee.
   Proposed: require one complete final verified summary, format BCH/FT units
   correctly, and expose any token loss explicitly. Source inspection did not
   execute a burn or sweep. Sources: `src/hooks/useHandleTransaction.ts:102`,
   `src/features/transaction/components/TransactionActions.tsx:90`,
   `src/pages/apps/airdrops/screens/AirdropDistributionScreen.tsx:1668`,
   `src/pages/PaperWalletSweep.tsx:413`.

9. **TX-09 — P1: approval is not consistently bound to the reviewed plan.**
   Airdrops builds `txPreview`, then on confirm
   `executeApprovedDistributionSend` calls the builder again. Cauldron pool
   creation also rebuilds after its review. The old fee/inputs/outputs can
   therefore differ from the submitted plan. Proposed: bind approval to a plan
   fingerprint and allowed terms; revalidate freshness without silently changing
   reviewed effects. Material changes require an updated review. Treat this as
   domain/authorization work with focused state tests, separate from cosmetic
   simplification. Sources: Airdrops executor lines 170–172 and Cauldron lines
   5150–5225. No changed transaction was broadcast in this assessment.

10. **TX-10 — P1: visible progress/retry is inconsistent.**
    SimpleSend mounts ReviewCard only in `mode === 'review'`; `doSend` immediately
    changes mode to sending, so its supplied hardware/sendStatus display cannot
    remain visible through signing. Connector approval buttons have no local
    in-flight guard/pending state. The shared App swipe stays completed after an
    async failure unless closed/reopened; Paryon supplies no loading prop and
    puts its error outside the modal. Proposed: explicit preparing → awaiting
    approval/device → signing → submitting → submitted/unknown/error states;
    guard duplicate responses and provide retry within the review when safe.
    Do not label submitted or unknown results confirmed.
    Sources: `src/features/simple-send/SimpleSend.tsx:789`,
    `src/hooks/useSimpleSend.ts:1014`, connector handlers and shared app modal.

11. **TX-11 — P1/P2: Cauldron's actual final reviews are less complete than the reference.**
    Ordinary swap review has pay/receive/minimum and large risk/route cards,
    but no network/LP fee rows; these live in a separate quote-details modal.
    Active withdrawal's swipe shows reserve values and immediately calls a
    handler that then builds/estimates and broadcasts; the fee-bearing
    `poolReview.kind === 'withdraw'` branch is not used by that CTA. Proposed:
    build the transaction before the single final review; always show fee and
    net wallet effect, with optional route/input data. Keep changed-liquidity
    and significant-price-risk warnings visible.
    Sources: `CauldronSwapApp.tsx:6755,7190,7353,7681,5002`.

12. **TX-12 — P2: Cauldron adds an unnecessary quote-details stop.**
    First Get Quote runs `handleQuoteAndOpenDetails`, opening the breakdown.
    The user closes it, then taps Review Swap and swipes. Normal-risk guidance,
    route counts, market-depth cards and warnings repeat across composer,
    details and review. Proposed: composer → Review swap (prepare fresh quote
    with progress) → one deliberate confirmation. Put the optional breakdown
    inside that review. The healthy path should have no warning checkbox;
    preserve an explicit acknowledgement for meaningful exceptional risks.
    Source: `CauldronSwapApp.tsx:4627,6351,6875,6988,7023`.

13. **TX-13 — P2: quote freshness guidance can age without updating.**
    The safety banner computes `Date.now()` in a memo without a timer dependency;
    a quote may cross its 60-second guidance boundary while the view is idle.
    Confirmation still rechecks pool state, so this is not evidence of a stale
    spend bypass. Proposed: explicit expiry/freshness state, Refresh quote on
    the same review, and require review again if important terms change.
    Source: `CauldronSwapApp.tsx:3498`; `quoteSafety.ts:71`.

14. **TX-14 — P1/P2: built-in apps do not share a reliable final review boundary.**
    Current FundMe Donate/Refund/Claim/Stop/Cancel invoke helpers that build and
    broadcast directly; capability consent/password prompts do not describe the
    concrete transaction. AuthGuard mixes build-only and explicit broadcast
    actions. Paryon applies the same SEND/swipe wording to live borrow/stake and
    preview-only redeem. Proposed: label executable versus preview-only actions
    truthfully and route each executable plan through host-owned review. Keep
    unimplemented/blocked products explicit. This needs per-app integration,
    not merely a shared popup skin. Sources: FundMeAddonApp lines 175–228,
    `fundmeTransactions.ts:86,100`; AuthGuardApp build/broadcast handlers;
    `ParyonWorkspaceApp.tsx:460,517,1315`.

### Proposed common preview and Cauldron simplification

Keep one visual vocabulary, with action-specific summaries rather than one
generic input/output table. The default review should answer, in order:

1. **Who requested this and which wallet/network is acting?** Show app identity
   and origin for external requests. App-supplied messages remain labelled as
   such and cannot replace wallet-verified facts.
2. **What will change?** Payment recipient and amount; swap pay/receive/minimum;
   liquidity deposited/withdrawn; token/NFT authority or contract changes. Show
   net wallet debit/credit and change distinctly, in correct units. Preserve
   full recipient/token identity through a touch/keyboard-accessible disclosure.
3. **What does it cost?** Network fee, swap/LP fee with its unit/inclusion, and
   total wallet debit. Explain shared/unknown fee contribution when relevant.
4. **What happens after approval?** Signature returned to app (which can spend
   it), wallet signs and submits, or wallet broadcasts an already signed result.
   Use the actual operation as the action label; keep cancel/reject explicit.
5. **What needs attention?** Keep actual burn, authority, stale quote and large
   price-risk consequences visible. Collapse transaction hashes, outpoints,
   scripts, route pools, raw data, byte size and routine low-risk explanation.

For Cauldron, aim for input → Review (fresh quote/build) → one confirmation →
result/tracking. Combine pay/receive, minimum receive, slippage and fee rows in
that one review; move route and market-depth inspection into Technical details.
Pool create/withdraw and merchant payment can use the same shell with their own
summary rows. Keep authentication and hardware authorization where required;
removing redundant screens must not remove those boundaries or stale-input checks.

Implementation order: correct network/accounting/token semantics and preview
validation first; normalize the verified plan in shared domain/application code;
then reuse the wallet presentation and deliberate-confirmation component;
finally consolidate Cauldron's quote/review path and integrate each built-in
app. Preserve React and the approved design; do not introduce independent
renderer-owned wallet policy. New authorization behavior needs its own tests.

### Executed checks and remaining acceptance

- Disposable component diagnostics plus existing review/connection tests:
  **3 files / 13 tests passed**, including **8 reproductions of current bugs**.
  Passing these diagnostics means the faults were reproduced, not repaired.
- Focused planner, WalletConnect/Wizard signing, CashConnect lifecycle,
  Cauldron preflight/safety, Airdrops execution and multisig review checks:
  **8 files / 41 tests passed**. These do not establish readable previews.
- Existing Vite warning: extensionless `./vitest.config` import in UI config.
- The diagnostic source/receipt remain on tmpfs; its temporary repository test
  file was removed after execution. No production source changes are part of
  this review. Current app fixes are still pending.
- Documentation Prettier checks, `git diff --check`, and receipt/source
  fingerprint reconciliation pass. Builds/typechecking were not rerun for
  this documentation-only assessment.

Next acceptance should exercise the same transaction across normal Send,
custom and each connector, including partial/counterparty inputs, tokens/NFTs,
missing metadata, invalid/missing source data, Chipnet, sign-only/broadcast,
double activation, rejection/expiry, hardware wait/cancel, changed quote/fee and
ambiguous broadcast. Capture final summaries, expanded details and recovery at
390×844, 412×915, compact desktop and a wide desktop viewport. Verify native
touch/Back/focus/status separately, storing only disposable redacted images on
tmpfs. All these rendered/platform cases remain open in this assessment.

### Transaction-preview implementation follow-up — 2026-10-24

The baseline UX changes were committed as `05456aa66` on
`codex/ux-basics-and-workflow`. The transaction-preview fixes below are in
`6f7237e4f` on that branch. The prior assessment is the reproduction
record; these statuses describe the subsequent implementation, not a
production acceptance.

| Finding  | Current result                                                                                                                                                                                                                                                                                        | Remaining verification or correction                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| TX-01    | Partial: WalletConnect/WizardConnect now distinguish whole-transaction figures from wallet effects; CashConnect names its action, prepared transaction count and estimated balance changes.                                                                                                           | Derive verified wallet-owned inputs/change/token deltas across connectors. Do not infer ownership from app prompts.                   |
| TX-02–03 | Source/component fixed: WalletConnect uses the selected network and rejects missing/invalid source data before enabling Sign. Input outpoints come from transaction inputs.                                                                                                                           | Real peer/device round-trip.                                                                                                          |
| TX-04    | Partial: reviews explain sign/return versus requested broadcast, including CashConnect handoff. WalletConnect reports broadcasted, submitted, failed, or hardware-not-attempted separately after returning signed bytes.                                                                              | Verify real peer/hardware results and make the connector result model consistent across WalletConnect, WizardConnect and CashConnect. |
| TX-05    | Partial: Wizard review and Mint's shared summary show NFT capability/commitment and token identity. Ordinary Send now reads the final built CashToken output, shows its full category and recipient, exposes NFT capability/commitment, and blocks approval when the selected token output is absent. | Apply the verified token/NFT summary to remaining app actions and verify BCMR display units with authenticated fixtures.              |
| TX-06    | Multisig total fixed to recipient plus fee. Merchant review no longer labels gross funding as wallet debit.                                                                                                                                                                                           | Calculate exact merchant net wallet effect, including token debit and change, from the built transaction.                             |
| TX-07    | Simple Send, custom builder and shared app modal have keyboard confirmation; shared modal now traps/restores focus and supports Escape.                                                                                                                                                               | Rendered keyboard, touch and screen-reader exercise on mobile/desktop.                                                                |
| TX-08    | Custom builder final review shows outputs/fee and blocks unaccounted input tokens; implicit fungible burn disabled. Airdrops formats BCH/token totals; sweep shows destination, fee and technical outputs. AuthGuard's broadcast paths now review built inputs, final outputs and fee.                | Broaden verified final summaries to the remaining in-scope executable app plans.                                                      |
| TX-09    | Airdrops compares the rebuilt transaction with the reviewed one. Cauldron pool and swap paths require another review after material signed-byte/fee/amount changes. AuthGuard broadcasts only the reviewed built hex and rejects wallet/network changes.                                              | Bind remaining executable app actions to concrete plans; test real stale UTXO/quote failures.                                         |
| TX-10    | Connector approval and shared app confirmation guard repeated activation; Paryon reports live action errors in the review and requires history check after an uncertain failure.                                                                                                                      | Preserve hardware progress through Simple Send mode transitions; model submitted/unknown/retry states per action.                     |
| TX-11–13 | Cauldron's first swap action opens final review directly; ordinary review includes network/LP fees and collapses routine detail. Withdraw prepares before final review. Quote-age guidance refreshes on a timer.                                                                                      | Verify rendered compact layout, actual mobile touch flow, and net effects.                                                            |
| TX-14    | Partial: CashConnect action semantics improved; Paryon preview-only redeem uses a plain “Finish preview” button and says it will not send. AuthGuard's three broadcast paths now require a cancellable transaction review.                                                                            | Verify AuthGuard in a rendered app and continue remaining in-scope per-action reviews.                                                |

FundMe findings above are historical review observations. At the user's direction,
FundMe implementation and verification are out of scope for this follow-up.
The AuthGuard source change has focused review-data tests; rendered, native and
live-chain behavior remain unverified.

All proposed fixes must preserve explicit transaction authorization and must not
treat component tests or React builds as proof of native, live-chain or release
readiness. The full affected flow inventory remains in this plan; inaccessible
peer/hardware/native states are verification gaps rather than passes.
