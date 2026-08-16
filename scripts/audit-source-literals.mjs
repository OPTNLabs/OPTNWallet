import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceRoots = [
  'src/components',
  'src/features',
  'src/pages',
  'src/platform',
];
const excludedSegments = new Set([
  '__tests__',
  'browser-extension',
  'extension',
  'node_modules',
  'dist',
  'build',
]);
const excludedFiles = new Set(['coreResources.ts', 'remainingResources.ts']);

function isThirdPartyAppScreen(file) {
  return (
    file.startsWith('src/pages/apps/') &&
    !file.endsWith('/MarketplaceAppHost.tsx') &&
    !file.endsWith('/AddonIframeHost.tsx')
  );
}

function filesUnder(directory) {
  const entries = readdirSync(resolve(repositoryRoot, directory), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    if (excludedSegments.has(entry.name)) continue;
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...filesUnder(relativePath));
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(relativePath);
  }
  return files;
}

function looksLikeTechnicalValue(value) {
  if (/\b(Promise|typeof|number|string|boolean)\b|=>/.test(value)) {
    return true;
  }
  return /^(BCH|NFTs?|FT|UTXOs?|QR|Tor|Quantumroot|WalletConnect|WizardConnect|CashFusion|CashTokens?|[0-9]+|https?:|wc:|wiz:)/i.test(
    value.trim()
  );
}

const candidates = [];
for (const sourceRoot of sourceRoots) {
  for (const file of filesUnder(sourceRoot)) {
    if (excludedFiles.has(file.split('/').at(-1))) continue;
    if (isThirdPartyAppScreen(file)) continue;
    const contents = readFileSync(resolve(repositoryRoot, file), 'utf8');
    const lines = contents.split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(?:\/\/|\/\*|\*|\{\/\*)/.test(line)) return;
      const checks = [
        ...line.matchAll(
          /(?:aria-label|title|placeholder|alt)\s*=\s*"([^"]+)"/g
        ),
        ...line.matchAll(/>([^<{\n]*[A-Za-z][^<{\n]*)</g),
      ];
      for (const match of checks) {
        const value = match[1].trim();
        if (!value || looksLikeTechnicalValue(value)) continue;
        candidates.push({
          file: relative(repositoryRoot, resolve(repositoryRoot, file)),
          line: index + 1,
          value,
        });
      }
    });
  }
}

console.log(
  `Found ${candidates.length} heuristic source-literal candidates in mobile/desktop core UI.`
);
for (const candidate of candidates) {
  console.log(`${candidate.file}:${candidate.line}: ${candidate.value}`);
}
console.log(
  '\nReview each candidate before converting it: dynamic user data, protocol diagnostics, internal logs, and add-on-owned values are intentionally excluded from the core catalog.'
);
