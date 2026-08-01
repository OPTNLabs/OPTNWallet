// Launch Tauri outside the library paths injected by the VS Code Snap.
// Those paths can make the native WebKit/GTK process resolve Snap's
// libpthread/libgdk stack instead of Ubuntu's matching system libraries.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

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

// Run the CLI's JS entry with this same node rather than the .bin shim.
//
// On Windows the shim is tauri.cmd, and since the CVE-2024-27980 fix Node
// refuses to spawn a .cmd without a shell — `npm run tauri:dev` died with a
// bare `spawn EINVAL` on Node 24. Going through a shell would fix that but
// reintroduces quoting problems for anyone whose checkout path contains a
// space. The package's own `bin` entry is plain JS, so there is nothing to
// shim: resolved from the CLI package itself so it survives a hoisted or
// nested node_modules layout.
const tauriEntry = createRequire(import.meta.url).resolve(
  '@tauri-apps/cli/tauri.js'
);
const child = spawn(process.execPath, [tauriEntry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  console.error(`[run-tauri] failed to start ${tauriEntry}:`, error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
