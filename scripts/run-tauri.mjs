// Launch Tauri outside the library paths injected by the VS Code Snap.
// Those paths can make the native WebKit/GTK process resolve Snap's
// libpthread/libgdk stack instead of Ubuntu's matching system libraries.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const env = { ...process.env };
const inheritedSnapKeys = [
  'GDK_PIXBUF_MODULEDIR',
  'GDK_PIXBUF_MODULE_FILE',
  'GIO_MODULE_DIR',
  'GIO_LAUNCHED_DESKTOP_FILE',
  'GIO_LAUNCHED_DESKTOP_FILE_PID',
  'GSETTINGS_SCHEMA_DIR',
  'GTK_EXE_PREFIX',
  'GTK_IM_MODULE_FILE',
  'GTK_PATH',
  'LOCPATH',
];

for (const key of Object.keys(env)) {
  if (key.startsWith('SNAP') || inheritedSnapKeys.includes(key)) delete env[key];
}

const tauriBin = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tauri.cmd' : 'tauri'
);
const child = spawn(tauriBin, process.argv.slice(2), {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  console.error(`[run-tauri] failed to start ${tauriBin}:`, error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
