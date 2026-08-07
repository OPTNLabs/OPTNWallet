# Diagnostics and observability

OPTN Wallet currently uses a privacy-first, local-only diagnostics buffer.
It records a bounded number of redacted application errors in memory so a
future support workflow can be designed without silently exporting wallet
data.

The diagnostics service must not:

- persist events to disk or browser storage;
- send events to a network service automatically;
- read wallet state, addresses, UTXOs, transaction contents, recovery phrases,
  private keys, WalletConnect session data, or credentials;
- be used to log raw exception objects or arbitrary application state.

Any future export or crash-reporting integration requires an explicit opt-in,
data-minimization review, retention policy, and security review before it is
enabled in a release build.
