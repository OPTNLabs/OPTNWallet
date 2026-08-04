# Security policy

OPTN Wallet handles recovery phrases and private keys. Do not report a
potential vulnerability in a public issue if it could expose funds, recovery
phrases, private keys, signing credentials, or release secrets.

Report security issues privately to the project maintainers with:

- a concise impact summary;
- affected version or commit;
- reproducible steps or a minimal proof of concept;
- whether the issue affects mobile, desktop, or both.

Do not include real recovery phrases, private keys, wallet files, or production
credentials in a report. Use a throwaway Chipnet wallet instead.

## Security expectations for contributors

- Never log or persist mnemonics or private keys in plaintext.
- Keep desktop secrets in the OS keychain and mobile secrets in secure storage.
- Keep `VITE_ENABLE_PRIVATE_KEY_VIEW=false` for release builds; enabling it is
  reserved for controlled development testing.
- Treat BCH UTXOs and token state as separate transaction invariants.
- Validate external input, wallet files, derivation paths, and network values.
- Make spend-triggering operations idempotent and safe to retry.
- Add regression tests for authorization failures, stale state, duplicate
  execution, malformed inputs, and partial writes.
- Do not weaken lock/unlock behavior to simplify tests or development.

The security review checklist is part of the pull request template. Releases
must pass the dependency audit, secret scan, and platform build gates.

Run `npm run security:ci` locally before security-sensitive changes. The
production audit currently gates on critical vulnerabilities; moderate and
unfixed transitive advisories remain visible in the audit output and must be
reviewed before promoting a release.
