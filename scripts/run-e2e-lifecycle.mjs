import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const projectRoot = process.cwd();
const temporaryDataHome = mkdtempSync(path.join(tmpdir(), 'optn-wallet-e2e-'));

const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (
    /^(SNAP|GTK_|GDK_PIXBUF|GIO_|GSETTINGS|LOCPATH|VSCODE_NLS_CONFIG$|XDG_DATA_HOME$|XDG_DATA_DIRS$)/.test(
      key
    )
  ) {
    delete environment[key];
  }
}

environment.TAURI_E2E_ALLOW_MUTATION = '1';
environment.XDG_DATA_HOME = temporaryDataHome;
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

if (process.platform === 'win32') {
  environment.APPDATA = temporaryDataHome;
  environment.LOCALAPPDATA = temporaryDataHome;
} else if (process.platform === 'darwin') {
  environment.HOME = temporaryDataHome;
}

const wdioBinary = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wdio.cmd' : 'wdio'
);

let exitCode = 1;
try {
  const result = spawnSync(
    wdioBinary,
    [
      'run',
      './e2e/wdio.conf.ts',
      '--spec',
      './e2e/specs/create-lock-reopen.spec.ts',
    ],
    { cwd: projectRoot, env: environment, stdio: 'inherit' }
  );
  exitCode = result.status ?? 1;
} finally {
  rmSync(temporaryDataHome, { recursive: true, force: true });
}

process.exit(exitCode);
