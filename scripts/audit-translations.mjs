import { translations } from '../src/i18n/resources.ts';
import {
  classifyTranslation,
  placeholderMismatch,
} from '../src/i18n/translationPolicy.ts';
import { SUPPORTED_LOCALES } from '../src/i18n/types.ts';

const requestedLocale = process.argv
  .slice(2)
  .find((argument) => !argument.startsWith('-'));
const jsonOutput = process.argv.includes('--json');
const locales = requestedLocale
  ? SUPPORTED_LOCALES.filter((locale) => locale === requestedLocale)
  : SUPPORTED_LOCALES;

if (requestedLocale && locales.length === 0) {
  console.error(
    `Unknown locale "${requestedLocale}". Supported locales: ${SUPPORTED_LOCALES.join(', ')}`
  );
  process.exitCode = 1;
} else {
  const englishKeys = Object.keys(translations.en).sort();
  const results = locales.map((locale) => {
    const resource = translations[locale];
    const localizedKeys = Object.keys(resource).sort();
    const missingKeys = englishKeys.filter((key) => !(key in resource));
    const extraKeys = localizedKeys.filter((key) => !(key in translations.en));
    const counts = {
      translated: 0,
      'needs-review': 0,
      'stable-term': 0,
      'external-value': 0,
      'internal-only': 0,
    };
    const placeholderMismatches = [];
    const needsReviewKeys = [];

    for (const key of englishKeys) {
      const englishValue = translations.en[key];
      const localizedValue = resource[key];
      if (localizedValue === undefined) continue;
      const status = placeholderMismatch(englishValue, localizedValue)
        ? 'needs-review'
        : classifyTranslation(key, englishValue, localizedValue, locale);
      counts[status] += 1;
      if (placeholderMismatch(englishValue, localizedValue)) {
        placeholderMismatches.push(key);
      }
      if (status === 'needs-review') needsReviewKeys.push(key);
    }

    return {
      locale,
      keys: localizedKeys.length,
      expectedKeys: englishKeys.length,
      missingKeys,
      extraKeys,
      placeholderMismatches,
      counts,
      needsReviewKeys,
    };
  });

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      console.log(`\n${result.locale}`);
      console.log(
        `  keys: ${result.keys}/${result.expectedKeys}; translated: ${result.counts.translated}; needs-review: ${result.counts['needs-review']}; stable-term: ${result.counts['stable-term']}; external-value: ${result.counts['external-value']}; internal-only: ${result.counts['internal-only']}`
      );
      console.log(
        `  missing: ${result.missingKeys.length}; extra: ${result.extraKeys.length}; placeholder mismatches: ${result.placeholderMismatches.length}`
      );
      if (result.missingKeys.length > 0) {
        console.log(`  missing keys: ${result.missingKeys.join(', ')}`);
      }
      if (result.placeholderMismatches.length > 0) {
        console.log(
          `  placeholder mismatches: ${result.placeholderMismatches.join(', ')}`
        );
      }
    }
  }
}
