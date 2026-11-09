# Add-on SDK release checklist

This checklist is the release gate for publishing the OPTN Wallet add-on SDK.
NPM publication is intentionally deferred until the open implementation and
evidence gates below are closed; no package publication is implied by this
branch.
Generic CashScript support is now part of the private pre-publication SDK;
contract-specific gates must use the current ABI, signer, lineage, CashToken,
and recovery requirements rather than the former “contracts absent” wording.
Items marked **implemented** have current source and test evidence on the
SDK hardening branch. Items marked **open** must remain disabled or explicitly
labelled unavailable in published documentation.

## Implemented

- **Public facade:** `src/services/addons/PublicSDK.ts` exports the documented
  third-party surface.
- **Capability enforcement:** manifest permissions, runtime authorization,
  rate limits, and timeouts are enforced by `AddonPolicyEngine`.
- **Secret boundary:** no mnemonic, private key, signature template, unlocker,
  ABI, or executable contract metadata crosses the public UTXO/API boundary.
- **Proposal authority:** proposals and operations are bound to wallet,
  session, grant revision, and authority context.
- **Idempotency:** proposal and execution requests reject key reuse with
  different content; each proposal/mode execution is serialized in-process
  and through a stable Web Lock when the platform provides one, with a
  proposal-level operation recheck preventing retries with a different key.
- **Transport boundary:** the temporary iframe bridge checks the originating
  window, supports the versioned method/params envelope, and keeps the legacy
  built-in message shape only for compatibility. The package transport uses
  explicit HTTP(S) origins, checks both peer window and response origin, and
  permits `targetOrigin: '*'` only for the explicit opaque-origin sandbox
  opt-in. Handshake grants and response identifiers, timestamps, and signing
  metadata are independently bounded and schema-validated. Legacy and
  versioned iframe parameters, plus public-client transport parameters, are
  bounded before dispatch; serialization failures fail closed. The low-level
  public transport also enforces the advertised SDK method catalog.
- **Mock host:** third-party developers can test proposal, approval, denial,
  operation, and unknown-submission flows without secrets or providers.
- **Persistence adapters:** host-owned durable proposal and operation stores
  plus restart reconciliation helpers exist behind internal interfaces. The
  operation store can enumerate persisted records for the host-only recovery
  coordinator, which reconciles `submission_unknown` records before exposing
  updated status to add-ons.
- **Encrypted persistence decorator:** `EncryptedAddonStorage` uses the
  wallet's existing crypto service before records reach host storage.
- **Read-side retention bound:** persistent proposal and operation stores apply
  their configured retention window while loading as well as while writing, so
  an overfull backing store cannot be materialized without a bound.
- **Marketplace persistence binding:** Marketplace SDK sessions use wallet,
  add-on, and network-scoped encrypted IndexedDB records for proposals and
  operations; token amounts survive persistence without losing their bigint
  semantics.
- **Startup recovery binding:** Marketplace startup scans persisted
  `submission_unknown` operations and reconciles validated transaction IDs via
  wallet-owned Electrum visibility. Missing or ambiguous visibility remains
  unknown; add-ons cannot promote it themselves. Individual provider failures
  do not abort reconciliation of later operations.
- **Private package contract:** `packages/addon-sdk` contains a dependency-free
  typed transport client, response projection, entrypoint helper, and a check
  that keeps the package private and free of wallet implementation imports.
  The generated ESM entrypoint is also imported by the contract check so
  extensionless-import regressions fail before publication.
- **Package-to-host integration:** the public package client is exercised against
  the secret-free mock wallet host in
  `packages/addon-sdk/test/mock-host.integration.test.ts`. This proves the
  documented UTXO projection, proposal rejection for executable unlockers,
  wallet-owned execution hand-off, and sanitized unknown-submission state.
- **Browser transport fixture:**
  `packages/addon-sdk/test/browser-runtime.integration.test.ts` runs the public
  postMessage connector against a browser-like `MessageEvent` runtime and
  proves handshake, capability grant, wallet-context request, and transport
  disposal. This is package/browser evidence; it does not substitute for an
  application-process adapter run.
- **Repeatable SDK suite:** run `npm run addons:test` for the combined host,
  bridge, persistence, authority, transport, and package integration tests.
- **Browser fixture command:** run `npm run addons:browser-test` to execute the
  isolated browser-runtime handshake fixture independently of the wallet UI.
- **Package manifest validation:** `defineAddon` rejects malformed manifests,
  host-private trust tiers, unsafe capabilities, wildcard/local HTTP hosts,
  and duplicate declarations before the host policy layer runs.
- **CashScript boundary:** ABI-shaped contract derivation and proposal methods
  are public. Contract construction, signer resolution, CashToken checks,
  fee/change calculation, and broadcast remain wallet-owned. Registry and
  provenance controls are future distribution policy, not an execution API.
- **Current recovery and E2E scope:** the existing pending-lock/recovery path
  is accepted for this WIP, and the desktop/browser/mobile E2E coverage remains
  the validation path. The isolated desktop lifecycle runner currently passes
  the lock/reopen scenario, and the desktop/browser mobile merchant path has
  reached the fixed-output review without broadcasting. Publication will still
  record the exact tested artifact and adapter evidence for every advertised
  surface. The managed Android emulator path now also reaches the fixed-output
  review without broadcasting; publication will still record the exact APK,
  emulator, and adapter versions used for this evidence.
  The dedicated Chipnet merchant spec also passes in review-only mode without
  broadcasting.
- **Adapter review evidence:** the isolated Chipnet review-only runners have
  been executed on this branch. The desktop/browser-mobile runner passed with
  the desktop merchant and browser-mobile buyer reaching fixed-output review;
  the desktop/Android runner passed with the desktop merchant and Android
  buyer reaching the same review state. Both imported the local Chipnet
  fixture and performed no broadcast. These prove wallet-adapter readiness at
  the review boundary; they do not by themselves prove the add-on package is
  wired through every application process.
- **Desktop restart evidence:** `npm run test:e2e:lifecycle` passed the
  isolated create-lock-reopen flow in a temporary wallet profile. This proves
  the desktop lifecycle survives close/reopen; encrypted add-on-store
  migration and cross-window atomicity remain separate checks.
- **Android instrumentation status:** the workflow-shaped direct instrumentation
  sequence passed on the attached Pixel 9 emulator: `androidLanding_watchOnlyCreate`
  passed, the host force-stopped `optn.wallet.app`, and a fresh
  `androidLanding_watchOnlyRelaunch` invocation passed. The Gradle
  `connected...` task is not valid evidence for this specific transition because
  separate invocations reinstall the target APK. Watch-only creation now flushes
  the wallet database and Redux persistence before navigation, and startup
  recovers durable wallet metadata when Redux state is absent.
- **CashToken proposal semantics:** explicit transfer, fungible mint, NFT
  mint, NFT mutation, and burn intents are represented in the commitment;
  proposal validation checks fungible deltas, NFT lineage, capabilities, and
  explicit destructive operations without exposing signing authority. BCH
  CashTokens amount, category, NFT commitment, and zero-amount rules are
  checked at the proposal boundary.
- **CashToken host authority boundary:** a private injected authority and
  execution router now keep token builders, key lookup, source-state refresh,
  and broadcast inside the wallet host.
- **Submission-result validation:** the CashToken and P2PKH wallet-submit
  authorities fail closed on runtime errors, malformed transaction IDs, and
  unknown broadcast states; regression coverage exercises both authorities.
- **Host-owned message signing boundary:** message signing is address-scoped,
  capability-gated, approval-gated, bounded to 8,192 characters, and returns
  only the signed response; private keys and signature templates remain host
  private.

## Open before publication

- **Standalone package release:** freeze the wire version, finalize the package
  name/version and compatibility policy, generate reviewed declarations and
  checksums, and remove the private publication guard only at the approved
  release gate.
- **Runtime persistence hardening:** prove transactional/cross-window locking,
  migration, retention, and recovery behavior for the encrypted stores on
  every supported platform. The recovery coordinator is wired into Marketplace
  startup and operation records carry an optional validated transaction ID;
  the durable-storage, lock, encrypted-storage, and recovery regression suite
  currently passes 52 tests across eight test files;
  the current no-Web-Locks fallback is process-local serialization only and is
  not publication evidence for cross-window atomicity;
  cross-platform restart evidence, migration coverage, and provider-specific
  correlation evidence are still required before restart recovery can be
  claimed as a publication guarantee.
- **CashToken authority:** implement and review the wallet-owned token builder,
  genesis/category handling, token-aware change, mint/burn signer invariants,
  and source-state verification. The controlled host path is wired,
  but standalone publication remains blocked until this gate has complete
  evidence.
- **Contract authority:** verify ABI argument types, contract identity and input
  lineage, signer purpose, deterministic state transitions, and resource
  limits. Generic execution is enabled only through the wallet-submit authority;
  signed export and arbitrary unlockers remain disabled.
- **Signing evidence:** verify message-signing purpose, address scope,
  approval UX, hardware/watch-only behavior, and signature encoding.
- **SDK client-process E2E:** run the public package through authenticated host
  transports in desktop, browser/mobile, and Android clients. Existing
  merchant payment E2E and the deterministic package-to-host test are useful
  evidence, but do not substitute for this surface-specific matrix.
- **Security review:** complete the review recorded in
  [`docs/addon-sdk-security-review.md`](./addon-sdk-security-review.md), covering
  bridge, runtime authority, persistence, signer, and CashToken code; resolve or
  explicitly disable every finding. The current production dependency audit
  also reports four high-severity Axios advisories through the OneKey hardware
  wallet dependency chain; this needs a reviewed upgrade or documented risk
  acceptance before wallet-wide publication.
- **Release artifacts:** generate declarations, changelog, compatibility
  policy, migration notes, checksums, and reproducible package evidence.

## Publication rule

Do not publish a capability whose implementation or evidence is still open.
The published package must advertise the exact SDK version, supported adapter,
supported capabilities, and unsupported operations.

## Recommended first publication scope

The first external release should advertise only:

- wallet context and sanitized address/UTXO reads,
- BCMR and token-index reads where host policy permits them,
- immutable BCH transaction proposals,
- wallet-owned approval and operation-status polling,
- address-scoped message signing through the approved signer flow,
- P2PKH BCH wallet-submit on the verified host adapter.

CashToken NFT/mint/burn execution, contract execution, signed transaction
export, and unverified mobile adapters remain disabled until their respective
gates have evidence.
