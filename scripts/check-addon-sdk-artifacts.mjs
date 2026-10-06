import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve('packages/addon-sdk');
const artifacts = ['dist/index.js', 'dist/index.d.ts'];

for (const relativePath of artifacts) {
  const bytes = await readFile(join(root, relativePath));
  const digest = createHash('sha256').update(bytes).digest('hex');
  console.log(`${digest}  ${relativePath}`);
}

