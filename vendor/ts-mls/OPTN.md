# Vendored ts-mls (Marmot AppDataUpdate fork)

Published npm `ts-mls` (`latest` 1.6.2, `rc` 2.0.0-rc.16) is RFC 9420 only.
It has no `app_data_dictionary` (`0x0006`) or `app_data_update` (`0x0008`).

[marmot-ts](https://github.com/marmot-protocol/marmot-ts) uses this fork as a
git submodule:

- repo: https://github.com/hzrd149/ts-mls
- branch: `marmot-required-ext`
- pin: `2ca5c43b77241245ef41a5dd834f151674877c2d`

Rebuild:

```
npx tsc -p vendor/ts-mls/tsconfig.optn.json
```
