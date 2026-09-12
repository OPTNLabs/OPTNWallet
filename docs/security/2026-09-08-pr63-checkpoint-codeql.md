# PR #63 checkpoint CodeQL review — 2026-09-08

**Current instruction: do not dismiss any security alerts.** The user explicitly
withdrew the dismissal route on September 8. The older proposals below are
historical classifications only; there is no pending approval request to execute.
Do not suppress rules, exclude fixtures, or obscure constants to clear the gate.
Fix verified production defects and retain evidence for findings that remain.

Original assessment: alerts **82–85 and 87–93** concern test material and
**86** reports an overwritten output buffer. This is a source-reviewed
assessment, not a statement that the entire wallet is secure.

Reviewed PR head: `8b92ff1702920f1d8229a06dc3c7aa602a020f94`.
CodeQL 2.26.4 analyzed merge commit `e4f83c17d929f43076ba262256ee501b207f521b`
on `refs/pull/63/merge`. Check `101894864011` reports these 12 new critical
annotations. The rule is `rust/hard-coded-cryptographic-value`; its generic
severity is 9.8, which does not establish that each reported path is exploitable.
See the [rule documentation](https://codeql.github.com/codeql-query-help/rust/rust-hard-coded-cryptographic-value/).

## Findings and reasons

Line numbers below refer to the reviewed head, not future edits.

| Alerts | Source | Assessment |
| --- | --- | --- |
| 82, 83 | `crates/optn-cli/tests/wallet_checkpoint.rs:72–73` | Public fixture passwords used to distinguish the correct and incorrect derived keys in the encrypted-file integration test. |
| 88, 89 | Same file, lines 72–73 | Public KDF salts used with those test passwords. The same salt deliberately isolates the wrong-password case. |
| 87 | Same file, line 64 | Fixed nonce for synthetic checkpoint fixtures. The two fixture plaintexts use different test-derived keys. Actual file stores invoke the production OS RNG. |
| 84, 85 | `crates/optn-runtime/src/hd_sync.rs:528–529` | Public passwords inside the module guarded by `#[cfg(test)]` at line 212. |
| 90, 91 | Same file, lines 528–529 | Public test salts inside that same test module. |
| 92, 93 | Same file, lines 535 and 545 | A deterministic test encryption and its matching decryption. Decryption with the matching nonce is required, not a second encryption. Authenticated malformed plaintexts later in this test use distinct nonces. |
| 86 | `crates/optn-chain-native/src/wallet_checkpoint.rs:56` | Zero initialization of a buffer that is completely overwritten by OS randomness before it reaches encryption. RNG errors return before sealing or writing. |

The Rust compiler excludes `#[cfg(test)]` modules from ordinary builds, and
Cargo builds integration tests as separate test executables. These are compiler
and target boundaries, not merely filenames or comments. See the
[Rust testing documentation](https://doc.rust-lang.org/book/ch11-03-test-organization.html)
and [Cargo target documentation](https://doc.rust-lang.org/cargo/reference/cargo-targets.html#integration-tests).
No production source includes the checkpoint integration-test file.

## Why alert 86 is a false positive

The full production sequence is initialization, `OsRng.try_fill_bytes`, error
propagation with `?`, encryption, then atomic file replacement. There is no path
from a failed RNG call to encryption or a successful write.

The pinned dependency chain is `rand_core 0.6.4 -> getrandom 0.2.17`.
[The exact rand_core source](https://github.com/rust-random/rand/blob/rand_core-0.6.4/rand_core/src/os.rs)
implements `try_fill_bytes` by calling `getrandom(dest)?`. Its own example uses
the same zero-initialize-then-fill pattern. The
[exact getrandom source](https://github.com/rust-random/getrandom/blob/v0.2.17/src/lib.rs)
fills the complete destination on success and chooses failure over known
insecure output. A partial fill followed by an error is therefore rejected by
our caller; it is never accepted as a nonce.

The [CodeQL 2.26.4 rule implementation](https://github.com/github/codeql/blob/codeql-cli/v2.26.4/rust/ql/lib/codeql/rust/security/HardcodedCryptographicValueExtensions.qll)
has a barrier for direct calls to `getrandom::fill` and `getrandom::getrandom`.
It also heuristically treats arguments to parameters named `nonce`, `salt`,
or `password` as sinks. This path calls through `OsRng::try_fill_bytes` instead.
The reported path from the initializer to `seal` is consistent with the wrapper
mutation not being modeled. That explanation is an inference from the rule and
the actual alert; no modified CodeQL query was run locally to prove the model
change. The RNG correctness conclusion comes from the dependency implementation
and the caller's error handling, independently of that inference.

Do not rename the parameter, obscure constants with arithmetic, replace the RNG
with a counter, or exclude these files from scanning just to remove an alert.
No such changes were made. No scanner/model pack was modified.

## Checks and limits of this judgment

`wallet_checkpoint_file_preserves_authenticated_compare_and_swap` passes: storing
the same checkpoint twice produces different ciphertext and revisions; stale
revisions, wrong keys, foreign wallets, and malformed existing files are refused.
The runtime restart regression passes: mutation of every ciphertext byte fails
authentication, malformed authenticated envelopes are rejected, and restore
does not restore spend freshness. These checks support the implementation;
they are not statistical certification of the operating system RNG.

AES-GCM still requires nonce uniqueness per key. NIST permits random IV
construction with at least 96 random bits and specifies a total limit of
2^32 encryptions per key for that construction, across instances. Our nonce is
12 bytes. This review does not certify the operating system RNG under FIPS or
prove a wallet-wide lifetime invocation budget. That budget belongs in the
remaining real key/session lifecycle, before high-frequency persistence is
mounted. See [NIST SP 800-38D, sections 8.2.2 and 8.3](https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=51288).

## Dismissal scope and current state

[GitHub explicitly documents test-only code as a valid dismissal case](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts#dismissing-alerts).
It also documents that dismissal applies to the matching alert across branches
and persists into later scans. Therefore each dismissal needs its exact source
justification; it is not a temporary PR-only waiver. Changed code must be
reviewed again. All scanning rules should remain enabled.

Automatic approval review rejected the proposed 12 dismissals because the
user had not explicitly authorized them. The user then requested deeper
internet research. **No alert was dismissed in this continuation.** Approval
was then pending; the September 8 no-dismissal instruction above supersedes it.
There is no pending dismissal action.

The assessment above covers these 12 checkpoint alerts only. It does not validate
older alert numbers, other bot findings, funded Chipnet spending, GUI behavior,
the complete Issue #71/#75 architecture, or release artifacts.

## Wallet-security follow-up: alerts 94–105

After the recovered security work was pushed as `5338e8e6`, the PR merge-ref scan
reported twelve additional annotations from analyzed merge `903017ebda30fd8de1cf1dd9c2e5fd21a2e12873`.
Their source was rechecked at `af8f00ac11f6f7c4f9f286c8bb6c094a85f806f3`, which also
includes the latest dev merge. All **24 alerts (82–105) remain open**. No dismissal
or scan-rule change was performed. The earlier approval request did not include
these new alerts and does not authorize them.

| Alerts | Source at af8f00ac | Assessment and recommendation |
| --- | --- | --- |
| 94–98 | `crates/optn-core/src/wallet_file.rs:283,291,306,312` | Public BIP39/TREZOR fixture passwords used for compatibility, password rotation and wrong-password rejection. The enclosing module is guarded by `#[cfg(test)]` at line 266. Recommend `used in tests`. |
| 99–102 | Same file, lines 317–320 | Empty, too-short, valid and mismatched strings exercise the password-input policy inside that test-only module. No shipped password is selected by these constants. Recommend `used in tests`. |
| 103 | `crates/optn-runtime/src/wallet_security.rs:307` | The empty old-password branch is reachable only when the already-open, ciphertext-bound session has an empty password. A protected session with missing current-password input is rejected by the following match arm. The old ciphertext is still decrypted and validated before replacement. This preserves the established explicit passwordless-wallet mode, not a hard-coded password for protected wallets. Recommend `false positive` for this specific finding; this does not claim a passwordless file has password secrecy. |
| 104, 105 | Same file, lines 267 and 313 | Both zero-initialized 56-byte buffers immediately pass to `WalletStorage::entropy`; the sole production native provider calls `OsRng.try_fill_bytes` at `crates/optn-platform-native/src/wallet_storage.rs:130`. Failure propagates before wallet creation/resealing or file writes. Successful OS filling supplies a 32-byte salt and two 12-byte nonces; core also rejects equal nonces. Recommend `false positive` for the zero-initialization reports. |

The upstream Rust compilation, rand_core/getrandom and CodeQL-model evidence
above also applies here. The runtime lifecycle test verifies changing an empty
password to a real password, refusal of a missing current password afterward,
wrong-password refusal, biometric empty-versus-absent behavior, and restart.
The real native CLI process verifies legacy ciphertext, password rotation,
account identity, and explicit wallet selection. These are behavioral checks,
not RNG certification or full wallet security certification.

Combined recommendation: **20 test-fixture findings and 4 false positives**.
This is a reviewed classification proposal only. A future source change must be
reassessed, and new private-store providers must preserve full-buffer OS entropy
or fail before encryption. The nonce lifetime and persistence limits above remain.

## Authenticated runtime persistence follow-up

The native session now derives a separate checkpoint key from its verified
private BIP39 seed using the already-resolved RustCrypto HKDF-SHA256 dependency.
The fixed extraction context is `OPTN/HD-wallet-checkpoint/v1`; expansion binds
canonical network and account path, separated by a NUL byte. This is an
application-specific use of [RFC 5869's context binding](https://www.rfc-editor.org/rfc/rfc5869.html#section-3.2),
not a new signing-key path or an unlock credential. An independent Python
hashlib/HMAC oracle checks the public BIP39/TREZOR vector; account, network and
passphrase separation are tested. No seed or checkpoint key enters renderer DTOs.

Because wallet-password rotation preserves that private seed, it does not need
to rewrite a second encrypted file atomically with the wallet file. Native
adapters reuse the existing bounded authenticated checkpoint codec, OS nonce
generation and compare-and-swap writer. The filename is an opaque hash of wallet
handle/network/account; this hash is a storage identifier, not a decryption key.

The runtime verifies stored ownership before replacing an open session, saves
accepted HD observations before publishing freshness, and rolls back visible
annotation changes on save failure. It rechecks wallet ciphertext after a
blocking save. Cancellation, queued lock, source revocation and elapsed auto-lock
time are checked before publication; committed revisions remain recorded even
when publication is cancelled. Restarts restore stale observations only.

These changes do not approve any alert dismissal. Rescan completeness remains
labelled by provider evidence; disk authentication does not promote a server
assertion to SHV/MMR verification. Malicious rollback of disk state, durable
address issuance/reservation and the nonce lifetime ceiling remain separate work.

## Allocation follow-up and newly reported fixtures

At `fe1bc092e34dcf85fb64129236101098e16cd353`, the PR merge ref reports two more
test-only findings: #106 is the empty password in the published BIP39 fixture
inside `wallet_sync.rs`'s test module; #107 is the counter nonce used by the
in-memory checkpoint test provider in `hd_sync.rs`'s test module. The latter
increments its write counter before sealing; production still uses fallible OS
randomness. Both are proposed `used in tests`, independently of the prior
24-alert proposal. All 26 remained open during this review; no dismissal or
scan-rule change was performed. Recheck exact locations on subsequent heads.

The current Rust allocation changes close durable private-wallet receive
issuance: even index zero is saved before display; stale writers fail CAS;
cancellation after a committed save retains the consumed index on reopen.
Allocation is separate from chain evidence and cannot confer freshness.
The v2 codec explicitly retains old branch-2 scope alongside canonical DeFi 7
without reinterpreting addresses. Rebuilds retain freeze/label controls.
Shared spend/change reservation, other wallet kinds and malicious disk rollback
are still separate work. This does not approve any alert dismissal.

An additional source review found that retaining a new CAS revision with old
memory after cancelled publication could overwrite a newer saved allocation.
The checkpoint session now requires reload after a committed write until its
candidate is accepted. The guard covers sync, annotations and receive issuance,
including a transient post-store wallet-file read error. It does not rely on a
subsequent lock or on the read failure continuing. Regressions verify that stale
memory cannot allocate again and reopen recovers the committed history/indexes.

## Current no-dismissal remediation

At PR head `0f6c351c`, CodeQL analyzed merge commit
`b68d894d61840a20df1a5c4413e66a3df38f0023` and reports **31 open alerts**,
#82-112. All use the same hard-coded cryptographic-value rule. The source review
accounts for every alert: 27 concern test material; four concern production
initialization or the guarded passwordless branch.

| Alerts | Current source evidence / action |
| --- | --- |
| #82-85, #87-102 | Existing test credentials, salts, nonces and password-policy inputs reviewed above. Keep the independent legacy ciphertext vector and boundary cases intact. |
| #106 | Published BIP39 fixture in `wallet_sync.rs`'s test module. |
| #107 | In-memory test checkpoint provider's incremented counter nonce; unrelated to the native production provider. |
| #108-112 | `wallet_checkpoint.rs`'s `#[cfg(test)]` authenticated-codec fixtures: offline allocation, malformed provenance and v1 branch-2 compatibility. Test-only encryption inputs are explicit; no production caller includes this module. |
| #86 | Native checkpoint storage now directly calls the already-resolved `getrandom 0.2.17` API and propagates failure before encryption/write. |
| #103 | The passwordless branch now passes its already-verified session credential. The guard still rejects omitted credentials for a password-protected wallet; no default password is synthesized. |
| #104-105 | `WalletStorage::entropy()` returns `Result<[u8; 56]>`; runtime creation and password changes consume only successfully returned material. The native provider directly calls fallible `getrandom` and returns the complete array. |

The direct RNG calls use the same implementation previously reached through
`OsRng`; no package version, cipher, format, platform or randomness source
changes. The pinned CodeQL rule explicitly models direct `getrandom` calls.
This makes that dataflow visible without a custom scanner model or exclusion.
Only a fresh scan can establish which alerts close automatically as fixed.
No result here authorizes dismissal or guarantees the CodeQL gate is green.

The new failure regression checks creation while closed, creation with a wallet
already open, and first-password setup. An entropy-provider error must leave
wallet ciphertext, visible state, active session, credential and epoch unchanged.
Existing password-change, stale-epoch, ciphertext-CAS and restart tests remain.

The separate repository-wide security inventory also contains default-branch
alerts and dependency advisories. They are not the PR merge-ref inventory.
Secret-scanning API access returned HTTP 404, so its alert list is unavailable;
do not report that as zero alerts. Before dependency updates, the full npm audit
reports 26 affected entries (11 high, 6 moderate, 9 low, no critical), including
development dependencies. A passing production-only check is not a clean full
dependency audit.

Four stale Rust advisory exceptions are removed from `deny.toml` and the Cargo
audit workflow. All six committed lockfiles already use patched quick-xml
(`>=0.41`) and quinn-proto (`0.11.17`) where present; none contains rkyv.
The primary RustSec records are [quick-xml duplicate attributes](https://rustsec.org/advisories/RUSTSEC-2026-0194.html),
[quick-xml namespaces](https://rustsec.org/advisories/RUSTSEC-2026-0195.html),
[quinn-proto reassembly](https://rustsec.org/advisories/RUSTSEC-2026-0185.html),
and [rkyv archive validation](https://rustsec.org/advisories/RUSTSEC-2026-0235.html).
Their gates will now catch regressions. The existing glib 0.18.5 advisory is
still unresolved; its separate cargo-deny exception has not been expanded or
treated as a fix. No GitHub security alert state has been changed manually.

## Verified scan and dependency remediation

PR head `4a9efef125854f8b4ef5bd1e42d87473d8999027` was scanned at merge
`4291986b71bafb136ef0de5a4ebc71808ea54f9e`. GitHub now reports the PR-ref
instances of **#86 and #103-105 as fixed**. Their dismissal timestamps remain
null. This is automatic scan evidence after the production code changes, not
a dismissal. The other **27 test-material alerts remain open**, and CodeQL
still fails. No rule, fixture exclusion or custom scanner model was added.

The next dependency slice removes all eleven high-severity npm entries by
updating WDIO, its browser downloader, `qs` and `tsx`. WDIO's maintained release
adopts patched `deepmerge-ts`; the scoped browser 3.2.2 override replaces the
vulnerable `extract-zip` path. Compatibility review covers WDIO's imported APIs,
ESM and the Node >=22.12 requirement. CI moves from Node 20 to 22.23.2 across
all twelve affected workflows. No platform matrix or existing job was removed.
The existing required dependency-audit job gains a full-graph high/critical
audit, alongside its production check. Primary evidence:
[WDIO release](https://github.com/webdriverio/webdriverio/releases/tag/v9.31.6),
[deepmerge-ts advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx),
[extract-zip advisory](https://github.com/advisories/GHSA-jmr9-qjv8-65gv),
[browser-tool changelog](https://github.com/puppeteer/puppeteer/blob/browsers-v3.2.2/packages/browsers/CHANGELOG.md),
and [Node release status](https://nodejs.org/en/about/previous-releases).

The clean npm install applies all eleven existing patches. Actual Chrome
152.0.7977.82 download/launch/navigation passes through both independently
installed npm and Yarn graphs on Node 22.23.2. All 126 npm platform entries
retain their versions/constraints and remain represented in Yarn, including
the twelve Linux entries initially omitted by the secondary lock writer.
These are build-tool compatibility checks, not wallet/device end-to-end tests.

Full npm audit now reports **15 affected entries: 0 high, 0 critical, 5 moderate,
10 low**. Remaining root advisories concern `diff`, `elliptic`, another `esbuild`
copy, React Router and `uuid`; propagation accounts for the larger entry count.
The existing React Router dependency-review allowlist and glib 0.18.5 exception
remain unresolved. No new exceptions were added. This is not a clean bill of
security for the repository, a release approval, or full #71/#75 completion.

The subsequent dependency slice upgrades React Router to 7.18.3 and removes
both historical React Router GHSA exceptions from dependency review. The
existing HashRouter shells remain; lazy route components are already module
scoped, and multisig navigation uses absolute routes. Only the three test-only
StaticRouter import paths change. No wallet business logic moves into JS/TS.
The [versioned migration guide](https://github.com/remix-run/react-router/blob/react-router%407.18.3/docs/upgrading/v6.md)
and existing route consumers were reviewed before the upgrade.

Scoped UUID and Mocha pins remove the remaining
[UUID bounds defect](https://github.com/advisories/GHSA-w5hq-g745-h8pq) and
[patch-parser denial of service](https://github.com/advisories/GHSA-73rr-hh4g-fpgx).
Vitest/vite-node use Vite 7.3.6 with patched esbuild 0.28.2, removing the
[Windows development-server file read](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr).
Independent npm/Yarn installs preserve all 100 logical native-package platform
targets (the old 126 lock paths included duplicate esbuild versions).
The actual Keystone request CBOR, plugin v5 identifiers and Mocha diff output
match the previous graph; UUID output bounds and malformed patch termination
are checked against the patched graph. All eleven existing package patches
still apply. The full existing application suite passes 1810 tests with nine
existing skips; core typecheck, lint and production build pass.

Full npm audit now has **six low affected entries**, all propagated from the
single remaining [elliptic advisory](https://github.com/advisories/GHSA-848j-6mx2-7j84).
There are no moderate, high or critical entries in that graph. Elliptic has no
patched published release in this audit; its legacy browser crypto dependency
still needs remediation. The Rust/CodeQL findings and native device/workflow
verification are separate. Nothing was dismissed or newly excepted.
