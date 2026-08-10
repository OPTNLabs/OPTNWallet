# Translation review exports

Each language has its own CSV under [`docs/translations/`](./translations/).
Every row includes the English source, the localized value, and a policy
status (`translated`, `needs-review`, `stable-term`, `external-value`, or
`internal-only`).
Non-English files include the English source column so native speakers can
review each translation in context.

- [English](./translations/en.csv)
- [Spanish](./translations/es.csv)
- [Portuguese (Brazil)](./translations/pt-BR.csv)
- [Chinese (Simplified)](./translations/zh-CN.csv)
- [Chinese (Traditional)](./translations/zh-TW.csv)
- [Vietnamese](./translations/vi.csv)
- [Arabic](./translations/ar.csv)
- [French](./translations/fr.csv)
- [Korean](./translations/ko.csv)
- [Japanese](./translations/ja.csv)
- [Russian](./translations/ru.csv)
- [Hausa (Nigeria)](./translations/ha-NG.csv)

Each file contains all 1,721 runtime translation keys. The export is generated
from the merged catalog in `src/i18n/resources.ts`, so it includes entries
currently split across `coreResources.ts`, `remainingResources.ts`, and the
locale sections of `resources.ts`.

The nine non-base locales currently combine reviewed overrides with an English
fallback for keys that still need translation. Those fallback entries are
intentionally included so reviewers can identify and replace them.

Regenerate it after catalog changes with:

```text
npx tsx scripts/export-translations.mjs
npx tsx scripts/audit-translations.mjs
npx tsx scripts/audit-source-literals.mjs
```

The CSV files are intended for peer review; the TypeScript catalogs remain the
source of truth.
