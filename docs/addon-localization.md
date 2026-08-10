# Add-on localization contract

Add-on localization is separate from the core wallet catalog. The wallet owns
the marketplace, permission prompts, loading/error states, and other host
chrome. An add-on owns its app screens and business-specific copy.

## Manifest metadata and built-in declarative add-ons

An add-on can provide locale bundles in its manifest:

```ts
localeBundles: [
  {
    locale: 'es',
    messages: {
      'manifest.description': 'Descripción del complemento',
      'app.example.name': 'Ejemplo',
      'app.example.description': 'Una aplicación de ejemplo',
      'screen.title': 'Título localizado',
    },
  },
];
```

Supported locales are the wallet's twelve locales. The runtime rejects
unsupported or duplicate bundles, non-string messages, oversized keys, and
oversized values. If the selected locale is absent, English is used; if
English is also absent, the manifest's original value is used.

Built-in declarative screens are rendered inside `AddonI18nProvider` and can
use the add-on-owned hook:

```tsx
const { t } = useAddonI18n();

return <h1>{t('screen.title', 'Example')}</h1>;
```

Do not put these messages into `src/i18n/resources.ts`. Add-on messages are
scoped to the owning manifest so they cannot override wallet keys.

### Dedicated built-in module catalogs

Repo-owned declarative modules keep their screen catalogs beside their screen
code. The current module IDs and catalog files are:

| Module ID          | Catalog                                         |
| ------------------ | ----------------------------------------------- |
| `airdrops`         | `src/pages/apps/airdrops/locales.ts`            |
| `authguard`        | `src/pages/apps/patient0/locales.ts`            |
| `cauldron`         | `src/pages/apps/cauldron/locales.ts`            |
| `fundme`           | `src/pages/apps/fundme/locales.ts`              |
| `memo-cash-reader` | `src/pages/apps/memo-cash-reader/locales.ts`    |
| `mint-cashtokens`  | `src/pages/apps/mint-cashtokens-poc/locales.ts` |
| `paper-wallet`     | `src/pages/apps/paper-wallet-sweep/locales.ts`  |
| `paryon`           | `src/pages/apps/paryon/locales.ts`              |

`AddonI18nProvider` merges the selected module catalog with the owning
manifest bundle. Manifest messages take precedence, so an installed developer
can override or extend the module's metadata without changing wallet core
resources. Standalone mobile/desktop routes use `AddonModuleI18nProvider`.
The catalog parity test in
`src/i18n/__tests__/addonModuleCatalog.test.ts` ensures every module has all
twelve supported locales.

This boundary is intentional: each add-on can ship and review its own
translations, while repeated controls use the add-on-local common catalog.
Third-party app business copy, user-entered campaign/token text, and protocol
identifiers remain owned by the add-on or its data source.

## Third-party iframe add-ons

Third-party `iframe-bundle` add-ons remain responsible for their own screen
translations. The host sends the selected locale and the add-on's locale
messages through the existing sandbox bridge. The bridge exposes:

```js
OptnAddonBridge.getLocale();
OptnAddonBridge.t('screen.title', 'Example', { count: 1 });
const unsubscribe = OptnAddonBridge.onLocaleChange((locale) => {
  // Re-render the add-on with the new locale.
});
```

The host never merges an untrusted bundle into the core catalog. Add-ons should
validate their own message keys and keep user-provided values, token metadata,
contract identifiers, and dApp prompts untranslated.

## Review checklist

- Include an English source value for every add-on message.
- Keep product/protocol terms such as BCH, CashTokens, and ParyonUSD stable.
- Translate descriptions, labels, warnings, accessibility text, and errors.
- Test locale changes while an iframe add-on is open.
- Review long strings and Arabic right-to-left layout on mobile and desktop.
- Keep add-on translation review separate from the core CSV exports.

To inventory remaining wallet-owned declarative screen literals, run:

```text
node scripts/audit-addon-literals.mjs
```

This heuristic intentionally excludes the iframe host and marketplace host.
Review each result before translating it because screens also display dynamic
campaign text, token metadata, addresses, and protocol diagnostics.
