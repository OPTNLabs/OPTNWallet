import {
  ADDON_SDK_CAPABILITIES,
  ADDON_SDK_METHODS,
  type AddonSDKMethod,
} from './contract.js';

export type AddonTransportRequestOptions = {
  signal?: AbortSignal;
};

export type AddonTransport = {
  request(
    method: AddonSDKMethod,
    params: unknown,
    options?: AddonTransportRequestOptions
  ): Promise<unknown>;
};

export type AddonPostMessageTransportOptions = {
  /** The authenticated peer window. The host must still verify event.source. */
  target: Window;
  /** Runtime session obtained from the wallet host/connector handshake. */
  sessionId: string;
  /** The event target receiving responses; defaults to the current window. */
  eventTarget?: Window;
  /** Required for normal origins. Opaque sandbox origins require explicit opt-in. */
  targetOrigin?: string;
  allowOpaqueOrigin?: boolean;
  timeoutMs?: number;
  sessionExpiresAt?: string;
};

export type AddonSessionDescriptor = {
  sessionId: string;
  protocolVersion: 1;
  expiresAt: string;
  capabilities: string[];
};

export type AddonPostMessageConnectOptions = {
  target: Window;
  eventTarget?: Window;
  targetOrigin: string;
  addonId: string;
  requestedCapabilities: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type AddonPostMessageConnection = {
  session: AddonSessionDescriptor;
  transport: AddonTransport & { dispose(): void };
  hasCapability: (capability: string) => boolean;
};

function isSessionDescriptor(value: unknown): value is AddonSessionDescriptor {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<AddonSessionDescriptor>;
  const expiresAt =
    typeof session.expiresAt === 'string' ? Date.parse(session.expiresAt) : NaN;
  return (
    typeof session.sessionId === 'string' &&
    session.sessionId.length > 0 &&
    session.sessionId.length <= 256 &&
    session.protocolVersion === 1 &&
    typeof session.expiresAt === 'string' &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() &&
    Array.isArray(session.capabilities) &&
    session.capabilities.length <= 64 &&
    new Set(session.capabilities).size === session.capabilities.length &&
    session.capabilities.every(
      (capability) =>
        typeof capability === 'string' &&
        capability.length > 0 &&
        capability.length <= 128 &&
        (ADDON_SDK_CAPABILITIES as readonly string[]).includes(capability)
    )
  );
}

/** Establishes a scoped session; no wallet keys or signing material cross this boundary. */
export async function connectAddonPostMessage(
  options: AddonPostMessageConnectOptions
): Promise<AddonPostMessageConnection> {
  if (!options.addonId || options.addonId.length > 256) {
    throw new Error('Add-on connect requires a valid addonId');
  }
  if (
    !Array.isArray(options.requestedCapabilities) ||
    options.requestedCapabilities.length > 64 ||
    options.requestedCapabilities.some(
      (capability) =>
        typeof capability !== 'string' ||
        capability.length === 0 ||
        capability.length > 128
    )
  ) {
    throw new Error('Add-on connect capabilities are invalid');
  }
  if (
    new Set(options.requestedCapabilities).size !==
    options.requestedCapabilities.length
  ) {
    throw new Error('Add-on connect capabilities must be unique');
  }
  const targetOrigin = resolveTargetOrigin({
    ...options,
    sessionId: 'connect-placeholder',
  });
  const eventTarget = options.eventTarget ?? window;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Add-on connect timeoutMs must be positive');
  }
  if (options.signal?.aborted) return Promise.reject(abortError());
  const requestId = createRequestId();
  const session = await new Promise<AddonSessionDescriptor>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new AddonSDKError({
            code: 'UNKNOWN',
            message: 'Add-on connect timed out',
            retry: 'after-delay',
          })
        );
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      const cleanup = () => {
        clearTimeout(timeout);
        eventTarget.removeEventListener('message', onMessage);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const onMessage = (event: MessageEvent<unknown>) => {
        if (
          event.source !== options.target ||
          (targetOrigin !== '*' &&
            event.origin !== undefined &&
            event.origin !== targetOrigin) ||
          !event.data ||
          typeof event.data !== 'object'
        )
          return;
        const data = event.data as Record<string, unknown>;
        if (
          data.type !== 'optn-addon-sdk-connect-response' ||
          data.requestId !== requestId
        )
          return;
        cleanup();
        if (data.ok && isSessionDescriptor(data.session)) {
          resolve(data.session);
        } else {
          reject(
            new AddonSDKError({
              code: 'PERMISSION_DENIED',
              message: 'Add-on connection was not authorized',
              retry: 'never',
            })
          );
        }
      };
      eventTarget.addEventListener('message', onMessage);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      options.target.postMessage(
        {
          type: 'optn-addon-sdk-connect',
          protocolVersion: 1,
          requestId,
          addonId: options.addonId,
          requestedCapabilities: options.requestedCapabilities,
        },
        targetOrigin
      );
    }
  );
  return {
    session,
    transport: createAddonPostMessageTransport({
      target: options.target,
      eventTarget,
      targetOrigin,
      sessionId: session.sessionId,
      sessionExpiresAt: session.expiresAt,
      timeoutMs,
    }),
    hasCapability: (capability: string) =>
      session.capabilities.includes(capability),
  };
}

type AddonPostMessageResponse = {
  type: 'optn-addon-sdk-response';
  protocolVersion: 1;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code?: AddonSDKErrorCode;
    message?: string;
    retry?: AddonSDKError['retry'];
    operationId?: string;
    retryAfterMs?: number;
  };
};

function isAddonPostMessageResponse(
  value: unknown
): value is AddonPostMessageResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<AddonPostMessageResponse>;
  return (
    response.type === 'optn-addon-sdk-response' &&
    response.protocolVersion === 1 &&
    typeof response.requestId === 'string' &&
    typeof response.ok === 'boolean'
  );
}

function createRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return `optn-addon-sdk-${random ?? `${Date.now()}-${Math.random()}`}`;
}

function abortError(): Error {
  return new DOMException('The add-on SDK request was aborted', 'AbortError');
}

const ADDON_ERROR_CODES: ReadonlySet<AddonSDKErrorCode> = new Set([
  'INVALID_REQUEST',
  'UNSUPPORTED_VERSION',
  'UNSUPPORTED_OPERATION',
  'PERMISSION_DENIED',
  'USER_REJECTED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'WALLET_LOCKED',
  'STALE_CONTEXT',
  'STALE_PROPOSAL',
  'UTXO_UNAVAILABLE',
  'VALIDATION_FAILED',
  'SIGNER_UNAVAILABLE',
  'RATE_LIMITED',
  'RESOURCE_LIMIT',
  'IDEMPOTENCY_CONFLICT',
  'OPERATION_PENDING',
  'SUBMISSION_UNKNOWN',
  'OPERATION_NOT_FOUND',
  'UNKNOWN',
]);

const ADDON_ERROR_RETRIES: ReadonlySet<AddonSDKError['retry']> = new Set([
  'never',
  'query-operation',
  'after-delay',
  'new-review',
]);

function isAddonErrorCode(value: unknown): value is AddonSDKErrorCode {
  return (
    typeof value === 'string' &&
    ADDON_ERROR_CODES.has(value as AddonSDKErrorCode)
  );
}

function isAddonErrorRetry(value: unknown): value is AddonSDKError['retry'] {
  return (
    typeof value === 'string' &&
    ADDON_ERROR_RETRIES.has(value as AddonSDKError['retry'])
  );
}

/**
 * Creates the browser transport for a versioned host connection. This is a
 * generic adapter, not an iframe dependency: external connectors can provide
 * another AddonTransport implementation. `allowOpaqueOrigin` exists only for
 * the temporary sandboxed iframe, whose origin is intentionally opaque.
 */
export function createAddonPostMessageTransport(
  options: AddonPostMessageTransportOptions
): AddonTransport & { dispose(): void } {
  const { target, eventTarget = window, timeoutMs = 30_000 } = options;
  if (!options.sessionId || options.sessionId.length > 256) {
    throw new Error('Addon postMessage transport requires a sessionId');
  }
  const targetOrigin = resolveTargetOrigin(options);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Addon postMessage transport timeoutMs must be positive');
  }
  const expiryMs = options.sessionExpiresAt
    ? Date.parse(options.sessionExpiresAt)
    : undefined;
  if (
    expiryMs !== undefined &&
    (!Number.isFinite(expiryMs) || expiryMs <= Date.now())
  ) {
    throw new AddonSDKError({
      code: 'SESSION_EXPIRED',
      message: 'Add-on SDK session has expired',
      retry: 'never',
    });
  }
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
      signal?: AbortSignal;
      onAbort?: () => void;
    }
  >();

  const handleMessage = (event: MessageEvent<unknown>) => {
    if (
      event.source !== target ||
      (targetOrigin !== '*' &&
        event.origin !== undefined &&
        event.origin !== targetOrigin) ||
      !isAddonPostMessageResponse(event.data)
    ) {
      return;
    }
    const response = event.data;
    const request = pending.get(response.requestId);
    if (!request) return;
    pending.delete(response.requestId);
    clearTimeout(request.timeout);
    request.signal?.removeEventListener('abort', request.onAbort!);
    if (response.ok) {
      request.resolve(response.result);
      return;
    }
    request.reject(
      new AddonSDKError({
        code: isAddonErrorCode(response.error?.code)
          ? response.error.code
          : 'UNKNOWN',
        message: response.error?.message ?? 'Add-on SDK request failed',
        retry: isAddonErrorRetry(response.error?.retry)
          ? response.error.retry
          : 'never',
        operationId: response.error?.operationId,
        retryAfterMs: response.error?.retryAfterMs,
      })
    );
  };
  eventTarget.addEventListener('message', handleMessage);

  const transport: AddonTransport & { dispose(): void } = {
    request(method, params, requestOptions = {}) {
      const [module, name] = method.split('.') as [
        keyof typeof ADDON_SDK_METHODS,
        string,
      ];
      if (
        !module ||
        !name ||
        !(ADDON_SDK_METHODS[module] as readonly string[] | undefined)?.includes(
          name
        )
      ) {
        return Promise.reject(
          new AddonSDKError({
            code: 'UNSUPPORTED_OPERATION',
            message: `Unsupported SDK method: ${method}`,
            retry: 'never',
          })
        );
      }
      if (expiryMs !== undefined && expiryMs <= Date.now()) {
        return Promise.reject(
          new AddonSDKError({
            code: 'SESSION_EXPIRED',
            message: 'Add-on SDK session has expired',
            retry: 'never',
          })
        );
      }
      if (requestOptions.signal?.aborted) return Promise.reject(abortError());
      const requestId = createRequestId();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          requestOptions.signal?.removeEventListener('abort', onAbort);
          reject(
            new AddonSDKError({
              code: 'UNKNOWN',
              message: 'Add-on SDK request timed out',
              retry: 'after-delay',
            })
          );
        }, timeoutMs);
        const onAbort = () => {
          clearTimeout(timeout);
          pending.delete(requestId);
          reject(abortError());
        };
        pending.set(requestId, {
          resolve,
          reject,
          timeout,
          signal: requestOptions.signal,
          onAbort,
        });
        requestOptions.signal?.addEventListener('abort', onAbort, {
          once: true,
        });
        target.postMessage(
          {
            type: 'optn-addon-sdk-request',
            protocolVersion: 1,
            requestId,
            sessionId: options.sessionId,
            method,
            params,
          },
          targetOrigin
        );
      });
    },
    dispose() {
      if (expiryTimer) clearTimeout(expiryTimer);
      eventTarget.removeEventListener('message', handleMessage);
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.signal?.removeEventListener('abort', request.onAbort!);
        request.reject(
          new AddonSDKError({
            code: 'SESSION_EXPIRED',
            message: 'Add-on SDK transport was disposed',
          })
        );
      }
      pending.clear();
    },
  };
  if (expiryMs !== undefined) {
    expiryTimer = setTimeout(() => transport.dispose(), expiryMs - Date.now());
  }
  return transport;
}

function resolveTargetOrigin(
  options: AddonPostMessageTransportOptions
): string {
  if (options.allowOpaqueOrigin) {
    if (options.targetOrigin && options.targetOrigin !== '*') {
      throw new Error(
        'Opaque-origin add-on transport requires targetOrigin "*"'
      );
    }
    return '*';
  }
  if (!options.targetOrigin || options.targetOrigin === '*') {
    throw new Error(
      'Addon postMessage transport requires targetOrigin; opt into an opaque origin only for the sandbox adapter'
    );
  }
  try {
    const parsed = new URL(options.targetOrigin);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      !parsed.origin ||
      parsed.origin === 'null'
    ) {
      throw new Error('invalid origin');
    }
    return parsed.origin;
  } catch {
    throw new Error(
      'Addon postMessage targetOrigin must be an absolute origin'
    );
  }
}

export type AddonSDKErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_OPERATION'
  | 'PERMISSION_DENIED'
  | 'USER_REJECTED'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'WALLET_LOCKED'
  | 'STALE_CONTEXT'
  | 'STALE_PROPOSAL'
  | 'UTXO_UNAVAILABLE'
  | 'VALIDATION_FAILED'
  | 'SIGNER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'RESOURCE_LIMIT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'OPERATION_PENDING'
  | 'SUBMISSION_UNKNOWN'
  | 'OPERATION_NOT_FOUND'
  | 'UNKNOWN';

export class AddonSDKError extends Error {
  readonly code: AddonSDKErrorCode;
  readonly retry: 'never' | 'query-operation' | 'after-delay' | 'new-review';
  readonly operationId?: string;
  readonly retryAfterMs?: number;

  constructor(args: {
    code: AddonSDKErrorCode;
    message: string;
    retry?: 'never' | 'query-operation' | 'after-delay' | 'new-review';
    operationId?: string;
    retryAfterMs?: number;
  }) {
    super(args.message);
    this.name = 'AddonSDKError';
    this.code = args.code;
    this.retry = args.retry ?? 'never';
    this.operationId = args.operationId;
    this.retryAfterMs = args.retryAfterMs;
  }
}
