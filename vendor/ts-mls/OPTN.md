# Vendored ts-mls (Marmot AppDataUpdate fork)

Published npm `ts-mls` (`latest` 1.6.2, `rc` 2.0.0-rc.16) is RFC 9420 only.
It has no `app_data_dictionary` (`0x0006`) or `app_data_update` (`0x0008`).

[marmot-ts](https://github.com/marmot-protocol/marmot-ts) uses this fork as a
git submodule:

- repo: https://github.com/hzrd149/ts-mls
- branch: `marmot-required-ext`
- pin: `2ca5c43b77241245ef41a5dd834f151674877c2d`

Only the external TypeScript source and generated declarations are retained.
Compiled JavaScript and the fork's development toolchain are intentionally not
checked in. Vite transpiles the pinned TypeScript source as part of the normal
application build.

The official Rust MDK is not a compatible replacement here: Paytaca uses the
legacy NIP-EE/ts-mls wire and state format, while MDK implements the current
Marmot protocol and does not currently ship production web bindings. Revisit
this exception when a compatible Rust/WASM boundary is available.
