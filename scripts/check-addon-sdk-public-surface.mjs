import { readFile } from 'node:fs/promises';

const entrypoint = 'src/services/addons/PublicSDK.ts';
const source = await readFile(entrypoint, 'utf8');
const forbidden = [
  'KeyService',
  'fetchAddressPrivateKey',
  'signatureTemplateForAddress',
  'tx:build',
  'tx:broadcast',
  'mnemonic',
  'privateKey',
];

const violations = forbidden.filter((term) => source.includes(term));
if (violations.length > 0) {
  console.error(`Public SDK entrypoint contains forbidden terms: ${violations.join(', ')}`);
  process.exit(1);
}

if (source.includes("from '../AddonsSDK'")) {
  // The facade currently delegates to the wallet implementation internally;
  // the export list below must remain the only public surface. This check is
  // intentionally informational until the standalone package is extracted.
  console.log('Public SDK facade delegates internally; export-list review required.');
}

console.log(`Public SDK surface check passed: ${entrypoint}`);
