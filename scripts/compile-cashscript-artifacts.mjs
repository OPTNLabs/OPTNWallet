import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileFile } from 'cashc';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(rootDir, 'cashscript');
const outputDir = path.join(rootDir, 'src', 'apis', 'ContractManager', 'artifacts');
const manifestPath = path.join(sourceDir, 'contracts.manifest.json');

function sanitizeArtifact(artifact) {
  const { source, debug, ...rest } = artifact;
  return rest;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const sourceFiles = manifest.map((entry) =>
    entry.endsWith('.cash') ? entry : `${entry}.cash`
  );

  const sourceEntries = await fs.readdir(sourceDir, { withFileTypes: true });
  const availableSources = new Set(
    sourceEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.cash'))
      .map((entry) => entry.name)
  );

  for (const sourceFile of sourceFiles) {
    const outputFile = `${path.basename(sourceFile, '.cash')}.json`;
    const sourcePath = path.join(sourceDir, sourceFile);
    const outputPath = path.join(outputDir, outputFile);

    if (!availableSources.has(sourceFile)) {
      if (await fileExists(outputPath)) {
        await fs.unlink(outputPath);
      }
      continue;
    }

    const artifact = compileFile(sourcePath);
    await writeJson(outputPath, sanitizeArtifact(artifact));
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
