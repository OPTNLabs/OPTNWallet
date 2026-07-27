// E2E harness for the desktop Tauri app, via the officially-recommended
// WebdriverIO + tauri-driver setup (see docs/e2e-testing.md for the full
// setup story, including why this uses the manual tauri-driver path
// instead of @wdio/tauri-service — the latter needs a new Rust plugin
// dependency in src-tauri for macOS support, which this pass didn't touch).
//
// tauri-driver itself launches the platform's native WebDriver
// (msedgedriver on Windows, WebKitWebDriver on Linux) to actually drive the
// Tauri window's WebView2/WebKitGTK content.
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Absolute path to the built debug binary. Not committed as a fixed path —
// every machine's Cargo target dir can differ (this repo's own CARGO_TARGET_DIR
// override is a concrete example). Build first with:
//   npx tauri build --debug --no-bundle
// then point this at the resulting exe/binary.
const APP_BINARY = process.env.TAURI_E2E_APP_BINARY;

// Path to tauri-driver (installed via `cargo install tauri-driver`).
const TAURI_DRIVER_PATH =
  process.env.TAURI_E2E_DRIVER_PATH ?? path.resolve(os.homedir(), '.cargo', 'bin', 'tauri-driver');

// Windows only: path to msedgedriver.exe matching the installed WebView2
// Runtime version exactly (see docs/e2e-testing.md for how to fetch it).
const NATIVE_DRIVER_PATH = process.env.TAURI_E2E_NATIVE_DRIVER_PATH;

let tauriDriverProcess: ReturnType<typeof spawn> | undefined;
let shuttingDown = false;

export const config: WebdriverIO.Config = {
  host: '127.0.0.1',
  port: 4444,
  specs: ['./specs/**/*.spec.ts'],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      'tauri:options': {
        application: APP_BINARY,
      },
    } as WebdriverIO.Capabilities,
  ],
  reporters: ['spec'],
  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },

  onPrepare: () => {
    if (!APP_BINARY) {
      throw new Error(
        'TAURI_E2E_APP_BINARY is not set. Build the app first (npx tauri build --debug --no-bundle) ' +
          'and point this env var at the resulting binary — see docs/e2e-testing.md.'
      );
    }
  },

  beforeSession: () => {
    const args = NATIVE_DRIVER_PATH ? ['--native-driver', NATIVE_DRIVER_PATH] : [];
    tauriDriverProcess = spawn(TAURI_DRIVER_PATH, args, {
      stdio: [null, process.stdout, process.stderr],
    });
    tauriDriverProcess.on('error', (error) => {
      console.error('tauri-driver error:', error);
      process.exit(1);
    });
    tauriDriverProcess.on('exit', (code) => {
      if (!shuttingDown) {
        console.error('tauri-driver exited unexpectedly with code:', code);
        process.exit(1);
      }
    });
  },

  afterSession: () => {
    shuttingDown = true;
    tauriDriverProcess?.kill();
  },
};

function onShutdown(fn: () => void) {
  const cleanup = () => {
    try {
      fn();
    } finally {
      process.exit();
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

onShutdown(() => {
  shuttingDown = true;
  tauriDriverProcess?.kill();
});
