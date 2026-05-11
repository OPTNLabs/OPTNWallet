# CashScript Sources

Editable CashScript contracts live here during development.

Build output is written to `src/apis/ContractManager/artifacts/` by `npm run cashscript:compile`.

The active source list is tracked in `contracts.manifest.json`. Add or remove source filenames there when you start or retire a managed contract.

The app should only import the compiled JSON artifacts, not these source files.
