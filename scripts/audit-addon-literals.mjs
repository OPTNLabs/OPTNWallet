import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const addonRoot = resolve(repositoryRoot, 'src/pages/apps');
const excludedNames = new Set([
  '__tests__',
  'AddonIframeHost.tsx',
  'MarketplaceAppHost.tsx',
  'marketplaceScreenResolver.tsx',
]);

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (/\.tsx?$/.test(entry.name) && !excludedNames.has(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function looksLikeStableValue(value) {
  if (/\b(Promise|typeof|number|string|boolean)\b|=>/.test(value)) {
    return true;
  }
  return /^(BCH|CashTokens?|NFTs?|FT|UTXOs?|QR|OPTN|FundMe|Cauldron|ParyonUSD|Memo\.cash|https?:|bchtest:|bitcoincash:|[0-9]+)$/i.test(
    value.trim()
  );
}

const candidates = [];
for (const file of filesUnder(addonRoot)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (/^\s*(?:\/\/|\/\*|\*|\{\/\*)/.test(line)) return;
    const matches = [
      ...line.matchAll(/(?:aria-label|title|placeholder|alt)\s*=\s*"([^"]+)"/g),
      ...line.matchAll(/>([^<{\n]*[A-Za-z][^<{\n]*)</g),
    ];
    for (const match of matches) {
      const value = match[1].trim();
      if (!value || looksLikeStableValue(value)) continue;
      candidates.push({
        file: relative(repositoryRoot, file),
        line: index + 1,
        value,
      });
    }
  });
}

console.log(
  `Found ${candidates.length} heuristic add-on screen literal candidates.`
);
for (const candidate of candidates) {
  console.log(`${candidate.file}:${candidate.line}: ${candidate.value}`);
}
console.log(
  '\nReview candidates by ownership: built-in declarative screens should use useAddonI18n; third-party iframe screens remain add-on developer-owned; dynamic data and protocol values stay external.'
);
