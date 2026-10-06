# OPTN Labs pitch evidence pack: business payments and spending controls

This pack is source-grounded evidence from the OPTN Wallet checkout at commit `c975268073d857064997b02bf45dca69a017492d` (`c9752680`; `npm` package `1.7.4`; `optn-cli` crate `1.7.3`). The checkout was dirty before this task because of a pre-existing `android/app/build.gradle` edit; that file was not changed.

The evidence is deliberately separated into wallet UI, SDK/CLI behavior, contract validation, and future platform gaps. No credentials, recovery phrases, private keys, customer identifiers, customer traction data, or complete QR payloads are retained in text or logs. The retained request screens use deterministic test/Chipnet state without retaining the full QR image. No customer portfolio, contribution volume, or FundMe.cash material is included.

## Three strongest investor-facing proofs

1. **A real payout request journey exists in the wallet.** Merchant Pay lets an operator choose BCH/PUSD, enter an amount, create a QR request, and show the buyer a fixed-output review; see the desktop and browser captures plus `demonstration/sequence.md`.
2. **The payment-control primitives are testable.** `CustodyVault` enforces owner/custodian/recovery signatures, BCH-only state, output shape and release timing in CashScript tests; `merchantPaymentMonitoring` recognizes exact pending/positive-height outputs and rejects wrong category/amount fixtures.
3. **The x402-bch CLI has a working protocol boundary.** The local trace parses an HTTP 402 BCH requirement, selects the UTXO option and reports the requested 1000 satoshis without spending; Rust unit tests cover amount compatibility, authorization serialization and refusal of non-BCH offers.

These are not equivalent claims: the first is a wallet interface, the second is contract/application test evidence, and the third is a CLI/SDK protocol trace. A passing test does not establish a shipped business dashboard or final settlement.

## Files

- [`capabilities.csv`](./capabilities.csv) — capability, benefit, layer, maturity, UI presence, source/test/build, enforcement boundary, limits and proof.
- [`payment_measurements.csv`](./payment_measurements.csv) — measured local/test timings and the explicit unavailable fields for raw transaction size and network settlement.
- [`screenshots/`](./screenshots/) — genuine captures from the existing desktop/browser E2E runner; original dimensions are recorded below.
- [`demonstration/sequence.md`](./demonstration/sequence.md) — ordered screenshot/test-trace demonstration and missing-step disclosure.
- [`logs/`](./logs/) — sanitized command results and the reproducible local x402 harness.

## Capture captions and dimensions

Each caption states what the viewer sees, the benefit, and the environment/build.

| Capture                                    | Original pixels | Caption                                                                                                                                                                             |
| ------------------------------------------ | --------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exact-1366x768-merchant-amount.png`       |        1366×768 | The exact desktop viewport shows the live Merchant Pay amount chooser and payout controls, giving an investor a full-width wallet proof on the current Chipnet fixture.             |
| `exact-1366x768-merchant-request.png`      |        1366×768 | The exact desktop viewport shows the generated merchant request after the operator entered 0.02 PUSD, proving the wallet-side request handoff in the deterministic fixture.         |
| `desktop-merchant-amount.png`              |        1280×794 | Merchant Pay shows BCH/PUSD selection, the amount keypad and the request action, giving an operator a direct payout-request path in the desktop wallet on the current dev checkout. |
| `desktop-merchant-amount-focused.png`      |         420×714 | This focused crop makes the Merchant Pay amount controls legible, showing the operator benefit without changing the underlying desktop capture or fixture state.                    |
| `desktop-merchant-amount-expanded.png`     |        1280×794 | The expanded settlement section exposes the conversion split, helping an operator understand how BCH and PUSD portions will be routed in the desktop Chipnet fixture.               |
| `desktop-merchant-request-preparing.png`   |        1280×794 | The desktop wallet is preparing the payment request after the operator entered 0.02 PUSD, showing the real request lifecycle before QR output.                                      |
| `desktop-merchant-request.png`             |        1280×794 | The desktop wallet displays the generated merchant payment request, giving a buyer a transportable request with the current Chipnet quote and fixed output.                         |
| `desktop-merchant-request-waiting.png`     |        1280×794 | The merchant wallet waits for the customer payment and explains the expected BCH/PUSD settlement, showing the operator-side monitoring state before broadcast.                      |
| `browser-mobile-buyer-payment.png`         |         500×758 | The buyer-facing mobile-width browser view shows the merchant, requested amount, conversion and payment preparation controls, helping a contributor review what will be paid.       |
| `browser-mobile-buyer-after-pay-click.png` |         500×758 | The buyer review shows BCH paid, merchant BCH/PUSD output, network fee and change behavior, giving a concrete spending-control review before authorization.                         |

The scoped capture-runner override now produces genuine 1366×768 desktop originals by accounting for native window chrome. The existing Firefox driver still cannot produce an honest 390×844 original: it enforces a 500px minimum content width and captures 500×758. A capture-only Chrome metrics attempt left this app’s React root empty, so no resized or synthetic files are presented as exact mobile originals. Exact-size mobile capture remains a product/demo setup gap.

## Commands and results

Focused validation passed:

- `npm exec -- vitest run --reporter=verbose src/pages/apps/merchant-pay/__tests__/merchantPaymentProposal.test.ts src/pages/apps/merchant-pay/__tests__/merchantPaymentMonitoring.test.ts src/pages/apps/merchant-pay/__tests__/MerchantPayApp.test.tsx src/apis/ContractManager/__tests__/custodyVault.test.ts src/services/addons/__tests__/SDKContract.test.ts src/services/addons/__tests__/AddonPolicyEngine.test.ts src/services/addons/__tests__/AddonIframeBridge.test.ts` — 7 files, 33 tests passed in 4.07s.
- `cargo test --manifest-path crates/optn-cli/Cargo.toml x402 -- --nocapture` — 7 x402 tests passed; no network or broadcast.
- `node docs/investor-evidence/logs/x402-check.local.mjs` — local HTTP 402 parsed successfully; 11ms observed in the retained run.
- `env -u OPTN_MERCHANT_E2E_ALLOW_BROADCAST MERCHANT_E2E_CAPTURE_DIR=docs/investor-evidence/screenshots MERCHANT_E2E_BROWSER_WIDTH=390 MERCHANT_E2E_BROWSER_HEIGHT=844 MERCHANT_E2E_DESKTOP_WIDTH=1366 MERCHANT_E2E_DESKTOP_HEIGHT=794 npm run test:e2e:merchant-desktop-browser-mobile` — genuine 1366×768 desktop captures and 500×758 mobile captures produced; review-only run stopped at the existing swipe-control assertion; no broadcast.

The first Rust test invocation downloaded uncached Cargo dependencies as part of the existing toolchain and compiled a local debug test binary. No application dependency manifest, release artifact, signing key, wallet file or credential was changed.

## Remaining product gaps and investor diligence

- There is no demonstrated sent-transaction/history capture: signing, broadcast, mempool observation, block confirmation and recipient availability were not run under this pack’s safety boundary.
- Merchant Pay recipient and amount protection is application/template validation; it is not a general business policy covenant or aggregate spend cap.
- `CustodyVault` release timing and authorization are contract/test evidence with a generic contract UI, not a dedicated business controls dashboard and not live-chain evidence.
- `AuthGuard` is a WIP/prototype token-gated app; the source carries `@ts-nocheck` and requires sensitive add-on capabilities.
- No dedicated budget ledger, per-user/recipient payment cap or batch payout UI was evidenced. The x402 flow’s reusable server credit is for API calls and should not be presented as batch contributor payroll.
- Token units are reported in atomic units; no FX, cash-out, provider or corridor cost was measured. Do not claim end-to-end savings without equivalent corridor examples and those costs.
- Founders still need to add the separately governed business material: anonymous payout-month aggregates, dated wallet/SDK adoption definitions, anonymous pipeline stages, redacted commercial terms, target segment/account basis and a 12–18 month budget.
