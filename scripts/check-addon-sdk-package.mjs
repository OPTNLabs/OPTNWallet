import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve('packages/addon-sdk');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

for (const artifact of ['dist/index.js', 'dist/index.d.ts', 'CHANGELOG.md']) {
  try {
    await readFile(join(root, artifact));
  } catch {
    throw new Error(`Missing generated SDK artifact: ${artifact}`);
  }
}

const publicEntry = await import(
  `${new URL('../packages/addon-sdk/dist/index.js', import.meta.url).href}?check=${Date.now()}`
);
for (const exportName of [
  'connectAddonPostMessage',
  'createAddonWalletClient',
  'defineAddon',
  'validateAddonManifest',
]) {
  if (typeof publicEntry[exportName] !== 'function') {
    throw new Error(`Missing public SDK export: ${exportName}`);
  }
}

if (manifest.private !== true) {
  throw new Error('The WIP add-on SDK package must remain private');
}
if (!manifest.exports?.['.']?.import || !manifest.exports['.']?.types) {
  throw new Error('The add-on SDK package must expose ESM and declarations');
}
if (!manifest.files?.includes('CHANGELOG.md')) {
  throw new Error('The add-on SDK package must include its changelog');
}
if (manifest.dependencies || manifest.peerDependencies) {
  throw new Error(
    'The public add-on SDK package must not depend on wallet implementation modules'
  );
}

const forbidden =
  /SignatureTemplate|privateKey|private_key|mnemonic|recoveryPhrase|seedPhrase|secretKey|unlocker|rawTransaction|KeyService|TransactionBuilder|ElectrumNetworkProvider|\bbroadcast\b/i;

async function walk(directory, extensions) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path, extensions);
      continue;
    }
    if (!extensions.some((extension) => entry.name.endsWith(extension)))
      continue;
    const contents = await readFile(path, 'utf8');
    if (forbidden.test(contents)) {
      throw new Error(`Forbidden wallet implementation symbol in ${path}`);
    }
  }
}

await walk(join(root, 'src'), ['.ts']);
await walk(join(root, 'dist'), ['.js', '.d.ts']);
console.log('Private add-on SDK package contract check passed.');
