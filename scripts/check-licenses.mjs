import fs from 'node:fs';

const lockfile = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const disallowed = /(?:^|[-+ ])(?:AGPL|GPL|SSPL|EUPL)(?:[-+ .]|$)/i;
const root = lockfile.packages?.[''] ?? {};
const directPackages = new Set([
  ...Object.keys(root.dependencies ?? {}),
  ...Object.keys(root.devDependencies ?? {}),
]);
const errors = [];
const warnings = [];

for (const [location, metadata] of Object.entries(lockfile.packages ?? {})) {
  if (!location || !metadata?.name) {
    continue;
  }

  const target = directPackages.has(metadata.name) ? errors : warnings;
  if (!metadata.license) {
    target.push(`Packages without lockfile license metadata: ${metadata.name}`);
    continue;
  }
  const license = Array.isArray(metadata.license)
    ? metadata.license.join(' OR ')
    : String(metadata.license);
  if (disallowed.test(license) && !/\bMIT\b/i.test(license)) {
    target.push(`Disallowed license: ${location}: ${license}`);
  }
}

if (errors.length > 0) {
  console.error('License policy failed:');
  for (const entry of [...new Set(errors)]) console.error(`- ${entry}`);
  process.exit(1);
}

console.log('License policy passed for direct dependencies.');
if (warnings.length > 0) {
  console.warn('Transitive license findings require review:');
  for (const warning of [...new Set(warnings)]) console.warn(`- ${warning}`);
}
