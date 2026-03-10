import { AppError, AppErrorCode, ErrorContext } from '../types/types';

const REDACT_KEYS = [
  'mnemonic',
  'seed',
  'seedphrase',
  'passphrase',
  'privatekey',
  'private_key',
  'secret',
  'signature',
  'rawtransaction',
];

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
  return REDACT_KEYS.some((sensitiveKey) => normalized.includes(sensitiveKey));
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[REDACTED_DEPTH]';
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.length > 512) return `${value.slice(0, 128)}...[TRUNCATED]`;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shouldRedactKey(k) ? '[REDACTED]' : sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function toErrorMessage(
  error: unknown,
  fallback = 'Unknown error'
): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export function createAppError(
  code: AppErrorCode,
  message: string,
  options?: { cause?: unknown; context?: ErrorContext }
): AppError {
  return {
    code,
    message,
    ts: Date.now(),
    cause: options?.cause,
    context: options?.context,
  };
}

export function logError(
  scope: string,
  error: unknown,
  context?: ErrorContext
): AppError {
  const appError = createAppError('UNKNOWN', toErrorMessage(error), {
    cause: error,
    context,
  });

  console.error(`[${scope}] ${appError.message}`, {
    code: appError.code,
    ts: appError.ts,
    context: sanitizeValue(appError.context),
    cause: sanitizeValue(appError.cause),
  });

  return appError;
}

export function logWarn(
  scope: string,
  message: string,
  context?: ErrorContext
) {
  console.warn(`[${scope}] ${message}`, {
    ts: Date.now(),
    context: sanitizeValue(context),
  });
}
