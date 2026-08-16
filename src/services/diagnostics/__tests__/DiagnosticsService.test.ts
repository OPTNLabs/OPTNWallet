import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDiagnostics,
  getDiagnostics,
  recordDiagnostic,
} from '../DiagnosticsService';

describe('DiagnosticsService', () => {
  afterEach(() => clearDiagnostics());

  it('redacts sensitive terms and keeps diagnostics in memory', () => {
    recordDiagnostic('ui.error', {
      message: 'private key and seed phrase must never be logged',
      componentStack: 'ErrorBoundary\n at Receive',
    });

    expect(getDiagnostics()).toMatchObject([
      {
        name: 'ui.error',
        details: {
          message: '[redacted] and [redacted] must never be logged',
          componentStack: 'ErrorBoundary at Receive',
        },
      },
    ]);
  });

  it('retains only the newest bounded set of events', () => {
    for (let index = 0; index < 105; index += 1) {
      recordDiagnostic('event', { index });
    }

    const diagnostics = getDiagnostics();
    expect(diagnostics).toHaveLength(100);
    expect(diagnostics[0]?.details.index).toBe('5');
  });
});
