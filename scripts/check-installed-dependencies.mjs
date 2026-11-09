import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
);
const lockfile = JSON.parse(
  fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')
);
const errors = [];
let checked = 0;

for (const section of ['dependencies', 'devDependencies']) {
  for (const name of Object.keys(packageJson[section] ?? {})) {
    const lockEntry = lockfile.packages?.[`node_modules/${name}`];
    if (!lockEntry) {
      errors.push(`${name}: missing from package-lock.json`);
      continue;
    }

    const installedPackagePath = path.join(
      root,
      'node_modules',
      ...name.split('/')
    );
    const installedManifestPath = path.join(
      installedPackagePath,
      'package.json'
    );

    let installedManifest;
    try {
      installedManifest = JSON.parse(
        fs.readFileSync(installedManifestPath, 'utf8')
      );
    } catch {
      errors.push(
        `${name}: not installed (run npm ci after switching branches)`
      );
      continue;
    }

    checked += 1;
    if (lockEntry.version && installedManifest.version !== lockEntry.version) {
      errors.push(
        `${name}: installed ${installedManifest.version}, lockfile requires ${lockEntry.version}`
      );
    }
  }
}

if (errors.length > 0) {
  console.error('Installed dependency check failed:');
  for (const error of errors) console.error(`- ${error}`);
  console.error(
    '\nRun `npm ci` after switching branches, then retry `npm run dev`.'
  );
  process.exit(1);
}

console.log(`Installed dependency check passed (${checked} direct packages).`);
