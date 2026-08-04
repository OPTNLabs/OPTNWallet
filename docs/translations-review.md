# Translation review export

The complete peer-review set is available as a single CSV:

- [translations-review.csv](./translations-review.csv)

Each row contains one translation key with the English, Spanish, and Simplified Chinese values side by side. The export is generated from the merged runtime catalog in `src/i18n/resources.ts`, so it includes entries currently split across `coreResources.ts`, `remainingResources.ts`, and the locale sections of `resources.ts`.

Regenerate it after catalog changes with:

```text
npx tsx scripts/export-translations.mjs
```

The CSV is intended for peer review; the TypeScript catalogs remain the source of truth.
