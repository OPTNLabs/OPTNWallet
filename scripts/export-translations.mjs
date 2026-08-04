import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { translations } from '../src/i18n/resources.ts';

const locales = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['zh-CN', 'Chinese (Simplified)'],
];

const outputPath = resolve(process.argv[2] ?? 'docs/translations-review.csv');
const keys = Object.keys(translations.en).sort((left, right) =>
  left.localeCompare(right)
);

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

const header = [
  'key',
  ...locales.map(([locale, label]) => `${label} (${locale})`),
];
const rows = [
  header,
  ...keys.map((key) => [
    key,
    ...locales.map(([locale]) => translations[locale][key]),
  ]),
];

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`,
  'utf8'
);

console.log(
  `Exported ${keys.length} translation keys for ${locales.length} locales to ${outputPath}`
);
