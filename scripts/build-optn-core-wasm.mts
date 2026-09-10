// Rebuilds the wallet's copy of crates/optn-core as WASM: compiles the crate
// for wasm32, generates the bindings, and embeds the binary as base64.
//
// The wallet doesn't compile Rust during a normal build, so the generated
// artifacts under src/wasm/optn-core are committed. Re-run this after changing
// crates/optn-core and commit what it produces.
//
// Loading is synchronous by design, for the same reason as
// scripts/generate-secp256k1-wasm-base64.mts: vite-plugin-wasm +
// vite-plugin-top-level-await can't be downleveled to the conservative target
// the mobile/web build needs for old Android WebViews. WebAssembly.Module and
// WebAssembly.Instance are synchronous constructors once bytes are in memory,
// so the binary is embedded and instantiated up front. That's why this uses
// wasm-bindgen's `web` target (which exposes initSync) rather than `bundler`
// (which needs the plugin pair).
//
// Connector tests compare this WASM against libauth, BCH VM execution and the
// public vectors also checked by native Rust. --check verifies freshness only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const crate = resolve(root, 'crates/optn-core');
// Everything under generated/ is owned by this script and wiped on each run.
// The hand-written loader and its test sit one level up, deliberately outside
// it -- an earlier version of this script rm -rf'd the parent and deleted them.
const outDir = resolve(root, 'src/wasm/optn-core/generated');

function run(command: string, args: string[], cwd = root): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** The wasm-bindgen CLI must match the crate version exactly, or it refuses. */
function requiredBindgenVersion(): string {
  const lock = readFileSync(resolve(crate, 'Cargo.lock'), 'utf8');
  const match = /name = "wasm-bindgen"\s*\nversion = "([^"]+)"/.exec(lock);
  if (!match)
    throw new Error('wasm-bindgen not found in crates/optn-core/Cargo.lock');
  return match[1];
}

const version = requiredBindgenVersion();

function sourceDigest(): string {
  const sources = [
    'crates/optn-core/Cargo.toml',
    'crates/optn-core/Cargo.lock',
    'scripts/build-optn-core-wasm.mts',
    ...readdirSync(resolve(crate, 'src'), { recursive: true })
      .filter((name) => typeof name === 'string' && name.endsWith('.rs'))
      .map(
        (name) => `crates/optn-core/src/${String(name).replaceAll('\\', '/')}`
      ),
  ].sort();
  const hash = createHash('sha256');
  for (const name of sources) {
    hash.update(name + '\0');
    hash.update(
      readFileSync(resolve(root, name), 'utf8').replaceAll('\r\n', '\n')
    );
    hash.update('\0');
  }
  return hash.digest('hex');
}

const generatedFiles = [
  'optn_core.js',
  'optn_core.d.ts',
  'optn_core_bg.wasm',
  'optn_core_bg.wasm.d.ts',
  'optnCoreWasmBase64.generated.ts',
];
function generatedDigests(): Record<string, string> {
  return Object.fromEntries(
    generatedFiles.map((name) => {
      const bytes = readFileSync(resolve(outDir, name));
      const normalized = name.endsWith('.wasm')
        ? bytes
        : bytes.toString('utf8').replaceAll('\r\n', '\n');
      return [name, createHash('sha256').update(normalized).digest('hex')];
    })
  );
}

if (process.argv.includes('--check')) {
  const manifest = JSON.parse(
    readFileSync(resolve(outDir, 'manifest.json'), 'utf8')
  ) as {
    sourceSha256: string;
    bindgenVersion: string;
    files: Record<string, string>;
  };
  if (
    manifest.sourceSha256 !== sourceDigest() ||
    manifest.bindgenVersion !== version ||
    JSON.stringify(manifest.files) !== JSON.stringify(generatedDigests())
  ) {
    throw new Error(
      'Rust sources or generated WASM changed: rebuild optn-core bindings'
    );
  }
  console.log('Shared Rust WASM sources and generated artifacts match');
  process.exit(0);
}

/**
 * Where the CLI actually is.
 *
 * `cargo install` puts binaries in `$CARGO_HOME/bin`, and this repo points
 * CARGO_HOME away from the default — so a correctly installed CLI need not be
 * on PATH, and reporting "not found" for it sends you off to reinstall
 * something you already have.
 */
function bindgenCommand(): string {
  const candidates = [
    process.env.CARGO_HOME
      ? resolve(process.env.CARGO_HOME, 'bin', 'wasm-bindgen')
      : null,
    'wasm-bindgen',
  ].filter((candidate): candidate is string => candidate !== null);

  for (const candidate of candidates) {
    try {
      run(candidate, ['--version']);
      return candidate;
    } catch {
      // Try the next candidate; exhausting them is reported below.
    }
  }

  const looked = process.env.CARGO_HOME
    ? `$CARGO_HOME/bin (${process.env.CARGO_HOME}) and PATH`
    : 'PATH';
  console.error(
    'wasm-bindgen CLI not found. It must match the crate exactly:\n' +
      `  cargo install wasm-bindgen-cli --version ${version} --locked\n` +
      `Looked in ${looked}.`
  );
  process.exit(2);
}

const bindgen = bindgenCommand();

if (
  !run('rustup', ['target', 'list', '--installed']).includes(
    'wasm32-unknown-unknown'
  )
) {
  console.log('Adding the wasm32 target');
  run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
}

console.log('Building optn-core for wasm32');
run(
  'cargo',
  ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown'],
  crate
);

// cargo honours CARGO_TARGET_DIR, which this repo sets, so ask rather than guess.
const metadata = JSON.parse(
  run('cargo', ['metadata', '--format-version', '1', '--no-deps'], crate)
) as { target_directory: string };
const wasmPath = resolve(
  metadata.target_directory,
  'wasm32-unknown-unknown/release/optn_core.wasm'
);
if (!existsSync(wasmPath)) throw new Error(`No wasm produced at ${wasmPath}`);

console.log('Generating bindings');
const relativeOutput = relative(root, outDir);
if (
  relativeOutput.startsWith('..') ||
  isAbsolute(relativeOutput) ||
  !relativeOutput
) {
  throw new Error('Generated output must stay inside this checkout');
}
for (
  let directory = outDir;
  directory !== root;
  directory = dirname(directory)
) {
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
    throw new Error(
      'Refusing to replace generated bindings through a symbolic link'
    );
  }
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
run(bindgen, [
  '--target',
  'web',
  '--out-dir',
  outDir,
  '--out-name',
  'optn_core',
  wasmPath,
]);

const bytes = readFileSync(resolve(outDir, 'optn_core_bg.wasm'));
const base64 = bytes.toString('base64');
const generated = `// GENERATED by scripts/build-optn-core-wasm.mts -- do not hand-edit.
// Base64 copy of the optn-core wasm binary, embedded so it's available
// synchronously at module-evaluation time -- see src/wasm/optn-core/index.ts
// for why, and scripts/generate-secp256k1-wasm-base64.mts for the same pattern
// applied to tiny-secp256k1.
export const OPTN_CORE_WASM_BASE64 = '${base64}';
`;
writeFileSync(resolve(outDir, 'optnCoreWasmBase64.generated.ts'), generated);
writeFileSync(
  resolve(outDir, 'manifest.json'),
  JSON.stringify(
    {
      sourceSha256: sourceDigest(),
      bindgenVersion: version,
      files: generatedDigests(),
    },
    null,
    2
  ) + '\n'
);

console.log(
  `Wrote ${outDir} (${(bytes.length / 1024).toFixed(1)} KB wasm -> ` +
    `${(generated.length / 1024).toFixed(1)} KB base64)`
);
console.log(
  'Verify with: npx vitest run src/services/connect/__tests__/ConnectSigningCore.test.ts'
);
