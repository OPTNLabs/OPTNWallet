// Structured logger for OPTN Wallet Desktop.
// Routes all console.* calls + explicit log calls to tauri-plugin-log,
// which writes timestamped entries to a rotating log file on disk:
//   Windows : %APPDATA%\com.optilabs.wallet\logs\optn-wallet.log
//   macOS   : ~/Library/Logs/com.optilabs.wallet/optn-wallet.log
//   Linux   : ~/.local/share/com.optilabs.wallet/logs/optn-wallet.log

import {
  debug,
  info,
  warn,
  error,
  attachConsole,
} from '@tauri-apps/plugin-log';

// Forward every console.* call to the Tauri log file automatically.
// This means all existing [AppLock], [SecretCrypto], [Electrum] etc. logs
// that already use console.log/warn/error are captured with zero changes.
export async function initLogger(): Promise<void> {
  try {
    // attachConsole pipes console.{log,info,warn,error,debug} → Tauri logger
    await attachConsole();
    info('[Logger] Desktop logger initialised — writing to log file');
  } catch (err) {
    // If Tauri IPC isn't ready yet (e.g. browser preview), fall back silently
    console.warn('[Logger] Could not attach Tauri logger, using console only:', err);
  }
}

// Structured log helpers with module prefix formatting.
// Usage: log.info('AppLock', 'PIN verified successfully')
// Output in log file: [INFO][AppLock] PIN verified successfully
export const log = {
  debug: (module: string, msg: string, ...args: unknown[]) =>
    debug(`[${module}] ${msg}${args.length ? ' ' + JSON.stringify(args) : ''}`),

  info: (module: string, msg: string, ...args: unknown[]) =>
    info(`[${module}] ${msg}${args.length ? ' ' + JSON.stringify(args) : ''}`),

  warn: (module: string, msg: string, ...args: unknown[]) =>
    warn(`[${module}] ${msg}${args.length ? ' ' + JSON.stringify(args) : ''}`),

  error: (module: string, msg: string, err?: unknown) => {
    const errStr = err instanceof Error
      ? `${err.message}${err.stack ? '\n' + err.stack : ''}`
      : err !== undefined ? String(err) : '';
    return error(`[${module}] ${msg}${errStr ? ': ' + errStr : ''}`);
  },
};
