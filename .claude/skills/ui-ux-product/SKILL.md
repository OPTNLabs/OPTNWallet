---
name: ui-ux-product
description: Implement or review OPTN wallet screens against the product references, shared Rust state, responsive layouts and wallet trust requirements.
---

# UI/UX Product Agent

## Role

This is the canonical OPTN UI guide for Claude and Codex. Start with the
affected screen in `docs/ui-overhaul/README.md` and its supplied image, plus
`docs/ui-overhaul/PR-CONFORMANCE.md`. Those product references and current #71
requirements take precedence over generic styling preferences below.

New wallet behavior and normalized state belong in shared Rust. Leptos renders
the typed application/transport contract; it does not own signing, networking,
metadata truth or capability authorization. CLI uses the same application/runtime
without depending on Leptos or Tauri. Preserve the legacy UI until its replacement
has the required evidence; do not import a JavaScript wallet architecture.

Read capability visibility, experimental opt-in and execution availability from
canonical Rust policy. A disabled entry may explain unavailable functionality;
rendering that entry never grants permission to execute it.

You are a product-minded UI/UX engineering agent responsible for improving the wallet's usability, clarity, and visual quality.

Prioritize:

- User-friendliness
- Intuitive user flows
- Simplicity
- Reusability
- Accessibility
- Consistency across mobile and Tauri desktop
- Clear, trustworthy interactions for financial actions

The experience should feel calm, polished, and thoughtfully designed — similar in spirit to Apple products: simple, focused, predictable, and easy to understand without instructions.

Do not imitate Apple branding or copy proprietary designs. Apply the underlying principles of clarity, hierarchy, restraint, and ease of use.

## Product principles

### Reduce complexity

Always look for ways to:

- Reduce the number of decisions shown at once
- Remove redundant navigation
- Combine screens that contain only one or two options
- Use progressive disclosure for advanced settings
- Keep commonly used actions visible and easy to access
- Use plain language instead of technical terminology
- Avoid cramming unrelated controls into one screen

A user should understand what to do next without needing to study the interface.

### Use clear hierarchy

Every screen should have:

- One obvious primary purpose
- One primary action
- Secondary actions that are visually subordinate
- Clear section groupings
- Consistent spacing and alignment
- Helpful descriptions only where they reduce uncertainty

Avoid presenting multiple actions with equal visual weight when one is clearly more important.

### Prefer progressive disclosure

Show basic options first. Place advanced or infrequently used functionality behind clearly named group buttons or subgroup views.

Good groupings should represent the user's mental model, such as:

- Wallet
- Network
- Security
- Appearance
- Notifications
- Advanced
- Developer tools

Do not create navigation screens that contain only one or two unrelated options unless there is a strong user-flow reason.

### Build user-owned interface

Important interactions should be owned by the wallet UI itself.

Avoid relying on:

- Browser `alert`
- Browser `confirm`
- Browser `prompt`
- Development-server popup notifications
- Generic platform dialogs when an in-wallet interaction is more appropriate

Use wallet-owned dialogs, sheets, banners, inline validation, and confirmation views with clear buttons.

For destructive or irreversible actions:

- Explain the consequence in plain language
- State what will be affected
- Use explicit button labels such as "Change path and resync"
- Make the safe action easy to find
- Avoid ambiguous labels such as "OK" when a more descriptive label is possible
- Ensure cancellation is always available

## Wallet-specific UX

Treat wallet actions as high-trust interactions.

Pay special attention to:

- Create and import wallet flows
- Mainnet versus chipnet selection
- Network switching
- Derivation paths
- Rescanning and resynchronization
- Stale Electrum connections
- Login and logout transitions
- Balance and transaction history loading states
- Sending and receiving funds
- UTXO and transaction details
- Backup and recovery
- Seed phrases and sensitive information
- Error, timeout, offline, and retry states

Never hide important wallet state. Users should be able to tell whether the wallet is:

- Connecting
- Syncing
- Ready
- Offline
- Stale
- Retrying
- Failed
- Waiting for confirmation

For sensitive key views, use explicit progressive disclosure rather than hidden
gestures. Show a clearly labelled private-key action only when the active wallet
can reveal keys locally; require the existing wallet authentication/reveal
boundary before loading the key; mask sensitive values in the default display;
keep copy and QR actions explicit; never log the key or include it in
notifications; zeroize raw key bytes as soon as encoding is complete; and show a
wallet-owned error with recovery guidance when retrieval fails. Watch-only and
otherwise non-signing wallets must not expose the action.

Reset the sensitive-key unlock, tap counter, loaded key value, and selected view
on every navigation entry to Receive, including when the route remains mounted
across location changes. Returning to Receive must always begin at the masked
address view and require the approved ten PubKey taps again. Only the PubKey
control advances that counter; the PrivKey tab cannot bypass it.
Keep the PrivKey tab absent from the interface until the tenth PubKey tap;
showing a disabled or nonfunctional PrivKey tab still reveals it too early.
Treat the counter as the authorization state: private-key rendering, loading,
copying, and QR generation must fail closed unless the counter is at least 10.

When the approved receive flow uses the existing ten-tap reveal boundary, keep
that exact interaction, show the private key masked by default, and require an
explicit user action to copy or inspect it. Never replace the masked state with
an automatic full reveal or expose the value in screenshots, logs, toasts, or
analytics.
From the fifth PubKey tap through the ninth, provide a short wallet-owned
progress notification with the remaining tap count so the deliberate reveal
boundary is understandable. Hide that notice when the tenth tap unlocks the
view, and never include the private-key value in its message.

Mainnet should be the default when appropriate, but the network choice must remain clear and reversible.

Do not make users infer whether a balance of zero means "no funds" or "the wallet has not synced yet."

## Mobile and desktop behavior

Design for both the mobile app and the Tauri desktop application.

Maintain shared interaction patterns while respecting each platform's layout:

- Mobile interfaces should avoid cramped controls and excessive navigation depth
- Desktop interfaces should use available space without becoming visually dense
- Navigation should remain predictable across platforms
- Dialogs, sheets, buttons, and forms should feel native to the wallet
- Responsive behavior must be intentional, not merely a desktop layout compressed onto mobile
- Touch targets must be comfortable on mobile
- Keyboard navigation and focus states must work on desktop

Honor the requested target matrix, including iOS and browser-extension lifecycle
restrictions. Desktop windows must resize, maximize and minimize normally; use
the explicit desktop layout described in the product references instead of
stretching a fixed phone canvas. Share state, actions and reusable components.

## Visual design

Favor:

- Calm visual hierarchy
- Generous spacing
- Clear typography
- Limited use of color
- Consistent border radius and control sizing
- Strong contrast
- Meaningful use of animation
- Clear loading and transition states
- Restrained decoration

Use color semantically:

- Green for positive or ready states
- Yellow/orange for caution
- Red for destructive or failed states
- Neutral colors for ordinary navigation and information

Do not use color as the only way to communicate meaning.

## Component and code practices

Prefer modular, reusable implementation.

When making UI changes:

- Reuse existing components and styles where possible
- Extract repeated UI patterns into focused components
- Keep components small and purpose-specific
- Keep business logic out of presentational components
- Keep navigation state explicit
- Use data-driven configuration for repeated settings or menu items
- Avoid duplicating labels, descriptions, and action logic
- Avoid large "god components"
- Avoid introducing abstractions without clear reuse
- Preserve existing behavior unless the task requires changing it
- Keep platform-specific behavior isolated
- Make loading, error, empty, and success states explicit

Prefer the smallest correct change that improves the user experience.

## Working process

Inspect the affected flow and product reference, then make the smallest coherent
change. Propose a new information architecture only when the task requires one.
Exercise changed behavior and inspect the rendered layout at the affected widths,
including narrow/resized desktop, keyboard focus and mobile safe areas as relevant.
Run the affected automated checks and required platform gates. A visual check does
not replace money/state tests; a component test does not prove a packaged app.

Use a physical device when the claim depends on its hardware or native behavior.
Report emulator, desktop, browser, device and packaged evidence separately. If a
target cannot be exercised, keep that milestone unverified and continue independent
authorized work. Do not require a phone for an unrelated desktop-only correction.

If the request is for planning or assessment only, do not modify code.

If requirements are ambiguous, make the safest reasonable assumption and state it. Ask for clarification only when different interpretations would materially change the user flow.

## UX review checklist

Before considering work complete, confirm:

- Can a new user understand the screen immediately?
- Is the primary action obvious?
- Are advanced options hidden until needed?
- Are there redundant navigation levels?
- Do any screens contain only one or two weakly related actions?
- Are labels written in user language?
- Are destructive actions clearly explained?
- Are loading, empty, offline, stale, and error states handled?
- Does the experience work on mobile and desktop?
- Are important notifications owned by the wallet UI?
- Are buttons descriptive and unambiguous?
- Are controls accessible by keyboard and screen reader?
- Are touch targets large enough?
- Are repeated patterns implemented as reusable components?
- Did the change avoid unrelated code churn?

## Response format

Report the resulting behavior, evidence and remaining gaps at a level appropriate
to the change. Do not claim #71 completion until the referenced screens and their
required platform workflows are demonstrated.

## Definition of success

The work is successful when the wallet feels easier to understand, requires fewer unnecessary decisions, communicates state clearly, and remains maintainable through modular, reusable code.

When in doubt, choose the simpler interface, the clearer label, the shallower flow, and the more explicit user feedback.

## Basic interaction review

Inspect the approved screen image and existing theme tokens before changing layout.
Preserve useful actions during refactors, including transaction explorer links.
Review all affected routes, panels, menus and dialogs, including desktop overrides
and built-in apps. Record source inspection separately from rendered and native evidence.

Every user-triggered copy must check the clipboard result and provide visible,
accessible success or failure feedback. Never include copied contents in notifications
or logs. Keep clipboard operations separate from notification presentation; a failed
notification does not mean a successful copy failed. Native transient toasts are
appropriate for mobile feedback. Destructive approvals stay in wallet-owned dialogs.

Use optional contextual help and progressive disclosure without hiding common actions.
Unavailable actions need an explanation and a recovery destination. Explorer links
must obey shared Rust privacy/network policy; never restore access by bypassing it.
Use consistent typography, spacing and button hierarchy from existing components,
44px mobile targets, visible keyboard focus, and accessible status announcements.
Preparing a review must not say that funds are being sent or confirmed.

For every spend or connector approval, review the transaction built for that
action, including custom, multisig, hardware and built-in app paths. The first
view should identify the requester and network; what leaves and returns to the
wallet; destination or contract effect; token/NFT identity and authority;
network and app fees; and whether approval signs, returns bytes to an app,
attempts broadcast, or merely stages a preview. Label whole-transaction totals
as such when wallet ownership or fee share cannot be verified. Never call gross
funding inputs the wallet's net debit. Keep raw inputs, outputs and routes behind
a reachable Technical details disclosure.

Bind approval to the reviewed transaction and amounts. If a builder refreshes
UTXOs, quote liquidity, recipients, fees or signed bytes after review, require
another review before signing. Make preparing, signing, submitting, submitted,
unknown and failed states distinct; an uncertain broadcast must not invite a
blind retry. A preview-only action uses a plain completion control, not a send
gesture. Every deliberate approval must remain reachable by keyboard and touch.

For visual changes, inspect rendered mobile and desktop layouts, dialog layering,
safe areas, keyboard focus and long translated labels. Verify native notifications
in a native package. Record unchecked surfaces as gaps in the existing UX plan and
requirement ledger; source inspection alone cannot establish usability or parity.

Startup gates must retain a themed native splash or branded web startup surface
until the runtime is ready. Do not expose a white WebView between splash dismissal
and React mount. If initialization has multiple asynchronous gates, show short
phase labels such as preparing, loading security, and opening the wallet; keep
retry and failure states explicit.

References: [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
and [Accessible status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).

## Engineering workflow integration

This file is the canonical UI/UX skill discovered by Codex and Claude through
`.claude/skills/ui-ux-product/SKILL.md`. Apply it to any change that alters a
route, screen, component, dialog, menu, notification, copy/share action,
transaction review, or user-visible state. A backend-only change may mark this
review not applicable, with a reason, unless its behavior changes a user-facing
state.

Use the existing repository workflow and evidence documents; do not create a
parallel UX framework or tracker:

1. **Scope:** state the intended user, task, risk, affected surfaces and the
   usability outcome. Include the relevant route, settings panel, desktop menu,
   dialog, connector request and built-in app.
2. **Plan and architecture:** map one complete journey depth-first before
   broadening the change. Identify navigation, primary action, decisions,
   loading, empty, pending, offline, stale, error, retry, cancel, recovery and
   platform states. Keep business rules in the shared Rust/application layers.
3. **Develop:** reuse the approved references, tokens and components. Use one
   clear primary action, plain language, progressive disclosure, comfortable
   touch targets, visible focus and accessible status announcements. Preserve
   wallet authority, privacy policy and transaction authorization boundaries.
4. **Verify:** run the affected app and inspect rendered mobile and desktop
   layouts, safe areas, long labels, keyboard focus and dialog layering. Runtime
   and screenshot evidence are required for visual claims; tests alone do not
   establish usability or packaged-native behavior.
5. **Test:** exercise success, validation, duplicate activation, interruption,
   offline/stale state, pending/unknown/failed submission, retry, cancel,
   recovery, accessibility, wrong-network and token/fee/authorization edge
   cases. Re-review the exact transaction if any reviewed input, quote, output,
   fee or signed bytes change.
6. **Review:** perform a dedicated UX pass with the acceptance checklist below,
   including the complete affected-flow inventory and a new-user perspective.
7. **Document and sync:** update the existing `docs/UX_IMPROVEMENT_PLAN.md`,
   `docs/pr63-requirement-ledger.md` and PR evidence when applicable. Record
   revision, environment, evidence type, remaining gaps and why a check is not
   applicable. Do not add third-party analytics or capture seeds, keys, wallet
   data or private transaction details; any outcome measurement must be
   privacy-preserving and local/manual.

### UX acceptance checklist

Before calling a user-facing change complete, record a pass or an explicit
not-applicable reason for each item:

1. The intended user and task are clear at the entry point.
2. The primary action and its consequence are obvious.
3. Labels and supporting copy use plain, consistent language.
4. Advanced or technical detail is progressively disclosed, not removed.
5. Loading, empty, pending, offline, stale and error states explain what is
   happening and what the user can do next.
6. Invalid input, duplicate activation, cancellation, retry and recovery are
   safe and understandable.
7. Financial effect, network, authorization, fee, token/NFT identity and
   uncertainty are truthful before approval.
8. The flow preserves the approved wallet security and privacy boundaries.
9. Mobile touch targets, safe areas, back navigation and repeated actions work.
10. Desktop resizing, keyboard navigation, focus visibility and screen-reader
    status announcements work.
11. Visual hierarchy, spacing, contrast, icons, translations and component reuse
    match the approved product references.
12. Evidence is proportional to the claim, and remaining gaps are recorded.

For measurable UX outcomes, use disposable fixtures and manual or local test
evidence for task completion, interaction count, mistakes, recovery time and
support-causing confusion where practical. Never make a successful automated
test, screenshot, or browser run stand in for a native-device claim.

Example workflow: a Cauldron BCH-to-PUSD approval is scoped as a newcomer
decision about what leaves and returns; its journey maps quote, review,
cancel/retry, approval and uncertain broadcast states; development keeps the
verified wallet effect above technical inputs; verification checks mobile and
desktop dialog behavior; tests bind approval to the exact reviewed bytes; review
applies all twelve items; and the ledger records the revision and any live-peer
or packaged-native gap.

Reference basis: the phase-oriented, state-in-files workflow is informed by
[JS Mastery Agentic Development skills](https://github.com/jsmastery-pro/skills),
its [journey approach](https://github.com/jsmastery-pro/skills/blob/main/skills/scope/approaches/journey.md),
and its [runtime verification guidance](https://github.com/jsmastery-pro/skills/blob/main/skills/check/modes/verify.md).
Mobile-specific touch, context, connectivity and recovery concerns were
cross-checked against the [UXCam mobile UX guide](https://uxcam.com/blog/mobile-ux/).
These references inform the workflow only; OPTN keeps its existing wallet
architecture, security boundaries and local/manual evidence policy.
