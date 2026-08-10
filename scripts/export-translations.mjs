import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { translations } from '../src/i18n/resources.ts';
import {
  classifyTranslation,
  placeholderMismatch,
} from '../src/i18n/translationPolicy.ts';

const locales = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['zh-CN', 'Chinese (Simplified)'],
  ['zh-TW', 'Chinese (Traditional)'],
  ['vi', 'Vietnamese'],
  ['ar', 'Arabic'],
  ['fr', 'French'],
  ['ko', 'Korean'],
  ['ja', 'Japanese'],
  ['ru', 'Russian'],
  ['ha-NG', 'Hausa (Nigeria)'],
];

const outputDirectory = resolve(process.argv[2] ?? 'docs/translations');
const keys = Object.keys(translations.en).sort((left, right) =>
  left.localeCompare(right)
);

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

mkdirSync(outputDirectory, { recursive: true });

for (const [locale, label] of locales) {
  const outputPath = resolve(outputDirectory, `${locale}.csv`);
  const header =
    locale === 'en'
      ? ['key', 'English (en)', 'Status']
      : ['key', 'English (en)', `${label} (${locale})`, 'Status'];
  const rows = [
    header,
    ...keys.map((key) =>
      locale === 'en'
        ? [
            key,
            translations.en[key],
            classifyTranslation(
              key,
              translations.en[key],
              translations.en[key]
            ),
          ]
        : [
            key,
            translations.en[key],
            translations[locale][key],
            placeholderMismatch(translations.en[key], translations[locale][key])
              ? 'needs-review'
              : classifyTranslation(
                  key,
                  translations.en[key],
                  translations[locale][key],
                  locale
                ),
          ]
    ),
  ];

  writeFileSync(
    outputPath,
    `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`,
    'utf8'
  );
}

console.log(
  `Exported ${keys.length} translation keys to ${outputDirectory} for ${locales.length} locales`
);
