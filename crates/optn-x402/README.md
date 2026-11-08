# OPTN BCH x402 adapter

This native-only adapter connects the x402 BCH Rust SDK to OPTN's trusted wallet
runtime. It owns protocol decoding, option selection, SDK transaction verification,
and header/receipt encoding. It owns no keys, coin selection, sockets or broadcast.
`PreparedWallet` returns only the transaction approved by OPTN for that request;
`PaymentSources` supplies authenticated parent bytes without fetching anything.

The SDK is pinned to the source commit of OPTNLabs/x402-bch#2 until it merges.
Move the dependency to the upstream merged revision and rerun both this crate's
tests and the CLI `x402_exact` process test before promoting the wallet PR.

This crate is excluded from the root workspace so its native SDK dependency does
not enter the shared WASM/UI graph. Its own lockfile and CLI-preview tests are
required. See `../optn-cli/README.md` for commands, recovery and current limitations.
