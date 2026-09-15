import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

const projectRoot = process.cwd();

// This loader is scoped to the explicit merchant Chipnet runner. The normal
// app/test commands never load wallet credentials, and the test spec only sees
// the named environment variable. Do not use a VITE_ prefix: Vite must never
// expose the mnemonic to the frontend bundle.
loadDotenv({ path: path.join(projectRoot, '.env'), override: false });

const mnemonic = process.env.OPTN_MERCHANT_E2E_MNEMONIC?.trim();

if (!mnemonic) {
  console.error(
    'OPTN_MERCHANT_E2E_MNEMONIC is required. Provide it in your local test environment; this runner never prints it.'
  );
  process.exit(2);
}

const environment = { ...process.env };

// VS Code's Snap runtime can inject GTK/WebKit paths from a different libc
// stack. Remove those process-local overrides so the Tauri binary and
// WebKitWebDriver use the runner's matching system libraries.
for (const key of Object.keys(environment)) {
  if (
    /^(SNAP|GTK_|GDK_PIXBUF|GIO_|GSETTINGS|LOCPATH|VSCODE_NLS_CONFIG$)/.test(
      key
    )
  ) {
    delete environment[key];
  }
}

// Merchant payment imports a wallet and therefore mutates the desktop data
// store. Keep the run isolated from the developer's normal OPTN profile.
const temporaryRoot = mkdtempSync(
  path.join(
    process.env.TMPDIR || process.env.TMP || '/tmp',
    'optn-merchant-chipnet-e2e-'
  )
);
const dataHome = path.join(temporaryRoot, 'data');
const configHome = path.join(temporaryRoot, 'config');
const cacheHome = path.join(temporaryRoot, 'cache');
mkdirSync(dataHome);
mkdirSync(configHome);
mkdirSync(cacheHome);

environment.XDG_DATA_HOME = dataHome;
environment.XDG_CONFIG_HOME = configHome;
environment.XDG_CACHE_HOME = cacheHome;
environment.TAURI_E2E_ALLOW_MUTATION = '1';
environment.TAURI_E2E_APP_BINARY ??= path.join(
  projectRoot,
  'src-tauri',
  'target',
  'debug',
  process.platform === 'win32'
    ? 'optn-wallet-desktop.exe'
    : 'optn-wallet-desktop'
);
environment.TAURI_E2E_DRIVER_PATH ??= path.join(
  homedir(),
  '.cargo',
  'bin',
  process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver'
);

const wdioBinary = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wdio.cmd' : 'wdio'
);

let result;
try {
  result = spawnSync(
    wdioBinary,
    [
      'run',
      './e2e/wdio.conf.ts',
      '--spec',
      './e2e/specs/merchant-payment-chipnet.spec.ts',
      ...process.argv.slice(2),
    ],
    { cwd: projectRoot, env: environment, stdio: 'inherit' }
  );
} finally {
  // This path is created exclusively by this runner and contains only the
  // temporary app profile. Do not point this cleanup at a user directory.
  rmSync(temporaryRoot, { recursive: true, force: true });
}

if (!result) process.exit(1);
process.exit(result.status ?? 1);
