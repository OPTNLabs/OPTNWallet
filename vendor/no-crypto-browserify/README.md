# crypto-browserify stand-in

`vite-plugin-node-polyfills` depends on `node-stdlib-browser`, which depends on
`crypto-browserify` 3.12.1. Through `create-ecdh` and `browserify-sign` that
installs `elliptic` 6.6.1, whose ECDSA can produce faulty signatures when the
RFC 6979 nonce `k` has leading zeros. Given one faulty and one correct
signature over the same input, an attacker can derive the private key
([GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84)).
Every elliptic release is affected, and none is fixed.

OPTN Wallet does not use that code. `vite.config.ts` excludes `crypto` from the
node polyfills, and its `optn-crypto-bundle-guard` plugin fails the build if
`elliptic`, `crypto-browserify`, `browserify-sign` or `create-ecdh` reach a
bundle. The packages were still installed, so `npm audit` reported them.

This private package `@optn/no-crypto-browserify` replaces `crypto-browserify`
through `overrides` (npm) and `resolutions` (Yarn), so none of those packages
is installed. `node-stdlib-browser` only calls `require.resolve` on it, which
still succeeds. Loading it throws, because loading it would mean something
tried to use the removed polyfill. It is **not** crypto-browserify. The version
`3.12.2-optn.1` sorts after the 3.12.1 it replaces, so a dependency review does
not take it for that release. `UPSTREAM.json` records what was replaced.

Remove this package when `node-stdlib-browser` stops requiring
`crypto-browserify`, or when elliptic publishes a fixed release.
