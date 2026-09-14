# PR #63 review audit — 2026-09-10

Audited against HEAD `6d24a4c8`. Dismissal was not treated as evidence: every
item below was checked against the code as it stands, and the automated
findings were traced to the commit and ref they were actually raised on.

## The dismissed lightswarm124 review

Review `5169408763`, submitted 2026-09-10T15:59:03Z, state `DISMISSED`.

**It carries no technical content to reconcile.** Verified through the API
rather than the web view:

| Query | Result |
| --- | --- |
| Review body length | 0 characters |
| Inline comments on review `5169408763` | 0 |
| Inline review comments by lightswarm124 anywhere on #63 | 0 |
| Issue comments by lightswarm124 on #63 | 0 |
| Unresolved review threads on #63, any author | 0 |

Commands used:

```
gh api repos/OPTNLabs/OPTNWallet/pulls/63/reviews --paginate
gh api repos/OPTNLabs/OPTNWallet/pulls/63/reviews/5169408763/comments
gh api repos/OPTNLabs/OPTNWallet/pulls/63/comments --paginate
gh api repos/OPTNLabs/OPTNWallet/issues/63/comments --paginate
gh api graphql  # reviewThreads(last:100), filtered isResolved==false
```

There is no substantive body and there are no inline findings, so there is
nothing to classify as valid, fixed, superseded or false. No findings have
been invented to fill the gap. If lightswarm124 intended to raise specific
concerns, they are not attached to the review or to the PR, and the review
should be re-submitted with content rather than reconstructed here.

## Code scanning (CodeQL) — open alerts

All three open alerts predate this PR. Each was raised on
`refs/heads/main` at commit `04c77316`, created 2026-08-11, and none was
introduced by #63.

### #3 and #4 — `js/incomplete-url-substring-sanitization`, `src/services/IpfsService.ts`

**Fixed on this branch; the alert is stale against `main`.**

The alert message is `'ipfs-api.optnlabs.com' can be anywhere in the URL, and
arbitrary hosts may come before or after it`, which describes a substring
test. The code on this branch does not do that:

```ts
function isKuboApiRelay(relayBase: string): boolean {
  try {
    return new URL(relayBase).hostname === KUBO_API_RELAY_HOST;
  } catch {
    return false;
  }
}
```

Parsing the URL and comparing `hostname` for equality is the fix CodeQL
recommends for this rule. `https://ipfs-api.optnlabs.com.evil.test/` and
`https://evil.test/?x=ipfs-api.optnlabs.com` both fail it, and a value that
does not parse as a URL returns `false` rather than throwing. The alerts stay
open because `main` has not been updated, not because the branch is exposed.

### #2 — `js/code-injection`, `public/addon-sandbox.html:69`

**By design, and the containment is real.** Executing the addon bundle is the
feature: this is the addon sandbox, and the flagged line is where an addon's
own code is run. What matters is that it runs with no authority, which is
verified rather than asserted:

- `iframe.setAttribute('sandbox', 'allow-scripts')` with **no**
  `allow-same-origin` (`AddonIframeBridge.ts:101`), so the frame has an opaque
  origin and no access to host storage, cookies or DOM.
- The sandbox page's CSP is
  `default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'`,
  so addon code cannot reach the network at all.
- `if (event.source !== parent) return;` gates initialization on source
  identity, so sibling frames and addon code cannot inject a bundle.

The residual risk is an addon doing whatever it likes *inside* an origin that
owns nothing and can talk to nobody, which is the intended trust boundary.
Suppressing the alert would be reasonable; leaving it open and documented is
also fine, since it correctly identifies where untrusted code enters.

## Other automation

CodeRabbit and github-advanced-security have review entries on #63, all with
empty bodies (status/summary postings). No unresolved threads from either.

The Fusion CBC IV findings (#129/#130) reviewed in
`2026-09-09-pr63-fusion-cbc-iv-codeql.md` no longer appear among open alerts.
