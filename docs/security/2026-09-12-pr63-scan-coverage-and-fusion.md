# PR63 security verification, 2026-09-12

Vendored Rust is included in CodeQL again (`61b11bc3`). The previous
`vendor/**` exclusion made old GLib alert closure unsuitable as evidence of a
source fix. The existing GLib backport and Linux regression/Valgrind checks
remain. The renamed `codeqlVendorCoverage.test.mts` requires unrestricted
source coverage and preserves the workflow and GLib regression assertions.

Alerts [146](https://github.com/OPTNLabs/OPTNWallet/security/code-scanning/146)
and [147](https://github.com/OPTNLabs/OPTNWallet/security/code-scanning/147)
identify the fixed CBC IV in `crates/optn-fusion/src/encrypt.rs`.
[Electron Cash's pinned implementation](https://github.com/Electron-Cash/Electron-Cash/blob/bb67161b162c1eea2ed2128dc224f7c55532cb8f/electroncash_plugins/fusion/encrypt.py)
uses that IV with a fresh ephemeral ECDH key for each encryption. The wire
format has no separate IV field. Changing the IV would break interoperability;
moving or hiding the constant would not repair security. This review did not
establish a key/IV-reuse exploit. Both findings remain visible for analyzer
review; this document does not dismiss or resolve either alert.

Authentication now uses the existing RustCrypto `Mac::verify_truncated_left`
API instead of a handwritten comparison loop. It preserves the 16-byte
left-truncated HMAC and authenticates before CBC decryption. The regression
rejects corruption at each tag position, and the existing format/padding,
roundtrip, tampering and wrong-key checks remain. Six encryption tests and
`cargo clippy --locked -p optn-fusion --all-targets -- -D warnings` passed.
This is authentication hardening, not a fix for the IV scanner findings or
evidence of a live paid Fusion round.

The read-only alert audit found 48 historical dismissals, dated September 5–6
(45 test fixtures, three false positives). Their metadata did not change during
this work. GitHub records an account, not which human or agent used it, so no
agent attribution follows from that audit. No alerts were dismissed or
suppressed by this work. Obtain completed Rust and JavaScript analyses for the
current PR revision before making any scanner-clear claim; cancelled or
missing analyses are not success.
