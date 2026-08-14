import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const projectRoot = process.cwd();
const environment = { ...process.env };

// VS Code's Snap runtime can inject GTK/WebKit paths from a different libc
// stack. Remove those process-local overrides so the Tauri binary and
// WebKitWebDriver use the runner's matching system libraries.
for (const key of Object.keys(environment)) {
  if (
    /^(SNAP|GTK_|GDK_PIXBUF|GIO_|GSETTINGS|LOCPATH|VSCODE_NLS_CONFIG$|XDG_DATA_HOME$|XDG_DATA_DIRS$)/.test(
      key
    )
  ) {
    delete environment[key];
  }
}

// The ordinary smoke suite is always non-mutating. The lifecycle runner is
// the explicit, isolated entry point for the create/lock/reopen scenario.
delete environment.TAURI_E2E_ALLOW_MUTATION;

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

const result = spawnSync(
  wdioBinary,
  ['run', './e2e/wdio.conf.ts', ...process.argv.slice(2)],
  { cwd: projectRoot, env: environment, stdio: 'inherit' }
);

process.exit(result.status ?? 1);
