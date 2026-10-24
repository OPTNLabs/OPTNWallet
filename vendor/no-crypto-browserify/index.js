'use strict';

// OPTN Wallet never polyfills Node's `crypto` for the browser: vite.config.ts
// excludes it from vite-plugin-node-polyfills, and the build fails if
// elliptic or crypto-browserify reaches a bundle. node-stdlib-browser only
// resolves this package's path, so loading it means something tried to use
// the removed polyfill. Use WebCrypto or the Rust core instead.
throw new Error(
  'crypto-browserify is not installed in OPTN Wallet: its elliptic dependency has no fixed release for GHSA-848j-6mx2-7j84. Use WebCrypto or the Rust core.'
);
