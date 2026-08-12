function noop() {
  // intentionally empty
}

export function installProductionConsoleGuards() {
  if (import.meta.env.DEV) return;

  const consoleRef = globalThis.console as Console & Record<string, unknown>;
  const suppressedMethods = [
    'log',
    'debug',
    'info',
    'warn',
    'trace',
    'group',
    'groupCollapsed',
    'groupEnd',
    'time',
    'timeEnd',
    'table',
  ] as const;

  for (const method of suppressedMethods) {
    if (typeof consoleRef[method] === 'function') {
      consoleRef[method] = noop;
    }
  }
}
