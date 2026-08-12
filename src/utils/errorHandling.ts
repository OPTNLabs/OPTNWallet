import { AppError, AppErrorCode, ErrorContext } from '../types/types';

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
    context: appError.context,
    cause: appError.cause,
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
    context,
  });
}
