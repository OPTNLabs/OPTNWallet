import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

const packageJson = readJson('package.json');
const lockfile = readJson('package-lock.json');
const errors = [];

if (!packageJson.packageManager?.startsWith('npm@')) {
  errors.push(
    'packageManager must declare npm as the canonical package manager'
  );
}

if (lockfile.lockfileVersion !== 3) {
  errors.push('package-lock.json must use lockfileVersion 3');
}

const rootPackage = lockfile.packages?.[''];
for (const section of ['dependencies', 'devDependencies']) {
  const manifest = packageJson[section] ?? {};
  const locked = rootPackage?.[section] ?? {};
  for (const [name, version] of Object.entries(manifest)) {
    if (locked[name] !== version) {
      errors.push(`${section}.${name} is out of sync with package-lock.json`);
    }
    if (/^(?:\*|latest|next|git\+|https?:)/i.test(version)) {
      errors.push(
        `${section}.${name} uses an unreviewable dependency spec: ${version}`
      );
    }
    if (/^file:/i.test(version) && !version.startsWith('file:vendor/')) {
      errors.push(
        `${section}.${name} uses an unreviewable dependency spec: ${version}`
      );
    }
  }
}

for (const [name, version] of Object.entries(packageJson.overrides ?? {})) {
  if (
    typeof version === 'string' &&
    /^(?:\*|latest|next|file:|git\+|https?:)/i.test(version)
  ) {
    errors.push(
      `overrides.${name} uses an unreviewable dependency spec: ${version}`
    );
  }
}

if (errors.length > 0) {
  console.error('Dependency policy failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  'Dependency policy passed: npm/package-lock.json are canonical and direct specs are reviewable.'
);
