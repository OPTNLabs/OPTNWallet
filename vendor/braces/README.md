# Build-only braces security fork

This is the MIT-licensed `braces` 3.0.3 runtime source, with the six library
changes from [upstream PR #78](https://github.com/micromatch/braces/pull/78),
commit `97308a01d091b211cf015314a2d0696da28a5392`. `UPSTREAM.json` records the
registry integrity, original source hashes and advisory. The original authors
and license are retained. This private package is named `@optn/build-braces`
and versioned `3.0.4-optn.1`; it is **not an upstream fixed release**.

One additional local deviation removes the inherited `console.log` in the
`node.isClose` branch of `lib/compile.js`. Compilation returns the same literal
or escaped closing text without writing to stdout. The parser and depth guards
are unchanged; a focused regression covers the return values and stdout.

The local patch version sorts after its upstream 3.0.3 baseline. The initial
`3.0.3-optn.1` incorrectly sorted before that baseline under SemVer. Yarn v1
records the consumer name `braces` for a local file replacement rather than
this package's scoped name, so dependency review misidentified that version
as unpatched upstream code. Correcting the fork version does not certify the
source: the actual nesting fix is the PR78 backport above, and the original
3.0.3 input-length/imbalanced-brace fix for
[GHSA-grv7-fg5c-xmjg](https://github.com/advisories/GHSA-grv7-fg5c-xmjg)
is retained and separately regression-tested. Upstream identity, version and
hashes remain recorded in `UPSTREAM.json` for future advisory review.

As of 2026-10-07, upstream has no release fixing
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
The patch caps brace/parenthesis parsing and all three recursive AST walkers
at depth 100. Excessive nesting fails with `SyntaxError` before stack
exhaustion, including caller-supplied `nodes` trees. Ordinary alternatives,
ranges, escapes and consumer APIs remain unchanged. Parser container depth
and walker call depth have different boundary counts.

This is not a general sandbox for arbitrary JavaScript objects, hostile
getters, malformed `parent`/array-valued `value` fields, or unbounded expansion
cardinality. Build tools pass pattern strings. Do not expose this library as a
wallet input-processing API; wallet logic remains in Rust.

Both package managers replace the build-tool transitive dependency with this
reviewable source. npm auditing cannot certify a local fork, so the dependency
audit job also runs adversarial and consumer regressions in
`scripts/__tests__/dependencySecurity.test.mts`. Registry auditing remains
enabled at the existing thresholds, with no advisory exclusion. Do not remove
these tests or merely change the package name/version to address a finding.

When upstream publishes a reviewed fix, remove this fork, its direct dependency
and both replacement rules together, regenerate both lockfiles, and rerun the
security regressions and build/lint tests. Until then, maintainers must track
upstream advisories and review this source; a green registry audit alone is
insufficient.
