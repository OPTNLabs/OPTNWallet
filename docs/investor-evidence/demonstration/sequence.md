# Payment-control demonstration sequence

This is an ordered screenshot/test-trace demonstration rather than a video because the supported review-only E2E path stops before the signing control can be exercised.

1. [exact-1366x768-merchant-amount.png](../screenshots/exact-1366x768-merchant-amount.png) — Merchant Pay shows the operator choosing the PUSD asset and entering an amount; this is the exact desktop wallet viewport on the current Chipnet fixture.
2. [exact-1366x768-merchant-request.png](../screenshots/exact-1366x768-merchant-request.png) — The wallet creates a payment request/QR payload for the fixed merchant output; this is the exact desktop wallet handoff using the Chipnet fixture and no broadcast.
3. [browser-mobile-buyer-payment.png](../screenshots/browser-mobile-buyer-payment.png) — The buyer sees the requested merchant, asset conversion and BCH amount before preparation; this is the browser/mobile wallet surface on Chipnet test data.
4. [browser-mobile-buyer-after-pay-click.png](../screenshots/browser-mobile-buyer-after-pay-click.png) — The buyer review shows the fixed merchant output, BCH network fee and change treatment; it is review-only and the test fixture did not reach a usable swipe-confirm selector.
5. [logs/vitest.focused.log](../logs/vitest.focused.log) — Deterministic tests recognize the exact pending/confirmed output and reject wrong token category, amount and malformed proposal cases; this is application/mock-provider evidence, not chain settlement.
6. [logs/x402-check.local.json](../logs/x402-check.local.json) — A local x402 server returns HTTP 402 with a 1000-satoshi BCH requirement and the OPTN CLI parses it; this is SDK/CLI evidence without signing or spending.

Layer ownership: steps 1–4 are wallet UI; step 5 is wallet application and contract tooling test evidence; step 6 is the Rust CLI x402 layer. The missing step is an allowed signing/broadcast path and resulting history/recipient observation, which was intentionally not run.
