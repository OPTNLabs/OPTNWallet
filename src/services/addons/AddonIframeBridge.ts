// Host-side bridge for 'iframe-bundle' addons (see public/addon-sandbox.html
// for the sandboxed side). Split into a pure dispatcher (testable without a
// real DOM/iframe) and a thin DOM-mounting layer, so the security-relevant
// logic — which SDK call an addon is actually allowed to make — is covered
// by a real unit test rather than only by manual iframe testing.
import {
  sanitizeAddonProposal,
  sanitizeAddonOperation,
  type AddonSDK,
  type AddonTransactionProposal,
} from '../AddonsSDK';
import type { AddonLocale } from '../../types/addons';
import { ADDON_SDK_PROTOCOL_VERSION } from './SDKContract';

const SANDBOX_URL = '/addon-sandbox.html';
const MAX_WIRE_PARAMS_BYTES = 64 * 1024;

type AddonWireError = {
  code:
    | 'INVALID_REQUEST'
    | 'UNSUPPORTED_VERSION'
    | 'UNSUPPORTED_OPERATION'
    | 'PERMISSION_DENIED'
    | 'USER_REJECTED'
    | 'STALE_CONTEXT'
    | 'STALE_PROPOSAL'
    | 'VALIDATION_FAILED'
    | 'UNKNOWN';
  message: string;
  retry: 'never';
};

function safeAddonWireError(error: unknown): AddonWireError {
  const raw = error instanceof Error ? error.message.toLowerCase() : '';
  if (raw.includes('permission') || raw.includes('capability')) {
    return {
      code: 'PERMISSION_DENIED',
      message: 'Permission denied',
      retry: 'never',
    };
  }
  if (raw.includes('user rejected') || raw.includes('denied')) {
    return {
      code: 'USER_REJECTED',
      message: 'User rejected the request',
      retry: 'never',
    };
  }
  if (raw.includes('stale') || raw.includes('authority context')) {
    return {
      code: 'STALE_CONTEXT',
      message: 'Wallet context is stale',
      retry: 'never',
    };
  }
  if (raw.includes('expired') || raw.includes('proposal')) {
    return {
      code: 'STALE_PROPOSAL',
      message: 'Proposal is no longer usable',
      retry: 'never',
    };
  }
  if (raw.includes('invalid') || raw.includes('requires')) {
    return {
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed',
      retry: 'never',
    };
  }
  if (raw.includes('unsupported') || raw.includes('unavailable')) {
    return {
      code: 'UNSUPPORTED_OPERATION',
      message: 'Operation is unavailable',
      retry: 'never',
    };
  }
  return {
    code: 'UNKNOWN',
    message: 'Add-on SDK request failed',
    retry: 'never',
  };
}

/**
 * Dispatch one {module, method, args} request from an addon against an
 * ALREADY capability-scoped AddonSDK instance (built by createAddonSDK — the
 * exact same object declarative apps use). The dispatcher enforces the
 * advertised method contract before invocation; the SDK method then performs
 * the capability check (see AddonsSDK.ts's authorizeCapability calls).
 */
export async function dispatchAddonSdkCall(
  sdk: AddonSDK,
  moduleName: string,
  methodName: string,
  args: unknown[]
): Promise<unknown> {
  const sdkRecord = sdk as unknown as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const mod = sdkRecord[moduleName];
  if (!mod || typeof mod !== 'object') {
    throw new Error(`Addon requested unknown SDK module: ${moduleName}`);
  }
  const info = sdk.meta.getInfo();
  const advertised = (info.methods as Record<string, readonly string[]>)[
    moduleName
  ];
  if (!advertised || !advertised.includes(methodName)) {
    throw new Error(
      `Addon requested unavailable SDK method (unknown SDK method): ${moduleName}.${methodName}`
    );
  }
  const fn = mod[methodName];
  if (typeof fn !== 'function') {
    throw new Error(
      `Addon requested unknown SDK method: ${moduleName}.${methodName}`
    );
  }
  const result = await (fn as (...a: unknown[]) => unknown).apply(mod, args);
  if (
    moduleName === 'tx' &&
    (methodName === 'propose' || methodName === 'getProposal')
  ) {
    return sanitizeAddonProposal(result as AddonTransactionProposal);
  }
  if (
    moduleName === 'tx' &&
    (methodName === 'requestExecution' || methodName === 'getOperation')
  ) {
    return sanitizeAddonOperation(result as never);
  }
  return result;
}

function objectParams(value: unknown, method: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid parameters for ${method}`);
  }
  return value as Record<string, unknown>;
}

function assertNoParams(value: unknown, method: string): void {
  if (value !== undefined && value !== null) {
    throw new Error(`Unexpected parameters for ${method}`);
  }
}

function assertBoundedParams(value: unknown, method: string): void {
  if (value === undefined || value === null) return;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`Invalid parameters for ${method}`);
  }
  if (typeof encoded !== 'string' || encoded.length > MAX_WIRE_PARAMS_BYTES) {
    throw new Error(`Parameters for ${method} exceed the SDK limit`);
  }
}

/**
 * Adapt the versioned `{method, params}` wire contract to the legacy SDK
 * object without forwarding arbitrary argument arrays. This is the temporary
 * iframe adapter; other transports should call the same typed SDK methods.
 */
export async function dispatchAddonSdkRequest(
  sdk: AddonSDK,
  method: string,
  params: unknown
): Promise<unknown> {
  assertBoundedParams(params, method);
  const [moduleName, methodName] = method.split('.');
  if (!moduleName || !methodName || method.split('.').length !== 2) {
    throw new Error(`Invalid SDK method: ${method}`);
  }
  const args: unknown[] = [];
  switch (method) {
    case 'meta.getInfo':
    case 'meta.getAuditTrail':
    case 'wallet.getContext':
    case 'wallet.listAddresses':
    case 'wallet.getPrimaryAddress':
    case 'utxos.listForWallet':
    case 'chain.getLatestBlock':
      assertNoParams(params, method);
      break;
    case 'wallet.toTokenAddress':
    case 'utxos.listForAddress':
    case 'utxos.refreshAndStore':
    case 'bcmr.getTokenMetadata':
    case 'bcmr.getTokenMetadataState':
      {
        const input = objectParams(params, method);
        args.push(input.address ?? input.category);
      }
      break;
    case 'tokenIndex.listTokenHolders':
    case 'tx.propose':
    case 'tx.requestExecution':
    case 'ui.confirmSensitiveAction':
    case 'signing.signMessage':
      args.push(objectParams(params, method));
      break;
    case 'tx.getProposal':
    case 'tx.getOperation':
      {
        const input = objectParams(params, method);
        args.push(input.proposalId ?? input.operationId);
      }
      break;
    case 'chain.queryUnspentByLockingBytecode': {
      const input = objectParams(params, method);
      args.push(input.lockingBytecodeHex, input.tokenId);
      break;
    }
    case 'http.fetchJson': {
      const input = objectParams(params, method);
      args.push(input.url, input.init);
      break;
    }
    default:
      throw new Error(`Unsupported SDK method: ${method}`);
  }
  return await dispatchAddonSdkCall(sdk, moduleName, methodName, args);
}

type SandboxMessage =
  | { type: 'optn-addon-ready' }
  | { type: 'optn-addon-init-ack'; ok: boolean; error?: string }
  | {
      type: 'optn-addon-sdk-call';
      requestId: string;
      module: string;
      method: string;
      args: unknown[];
    }
  | {
      type: 'optn-addon-sdk-request';
      protocolVersion: number;
      requestId: string;
      sessionId: string;
      method: string;
      params?: unknown;
    }
  | {
      type: 'optn-addon-sdk-connect';
      protocolVersion: number;
      requestId: string;
      addonId: string;
      requestedCapabilities: string[];
    };

function postSandboxMessage(iframe: HTMLIFrameElement, message: unknown): void {
  // The sandbox intentionally omits allow-same-origin, so its origin is opaque.
  // event.source is checked against this exact iframe before any message is
  // handled; '*' is required for delivery but does not authorize a caller.
  // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
  iframe.contentWindow?.postMessage(message, '*');
}

export type MountAddonIframeOptions = {
  container: HTMLElement;
  bundleSource: string;
  sdk: AddonSDK;
  sessionId: string;
  locale: AddonLocale;
  localeMessages: Readonly<Record<string, string>>;
  onInitError?: (message: string) => void;
  /** Host-owned lock/revocation check evaluated for every SDK message. */
  isSessionActive?: () => boolean;
  /** Consent/policy boundary for external-style connection requests. */
  onConnectRequest?: (request: {
    addonId: string;
    requestedCapabilities: string[];
  }) => Promise<{
    sessionId: string;
    expiresAt: string;
    capabilities: string[];
  } | null>;
};

export function isValidAddonConnectRequest(value: unknown): value is {
  type: 'optn-addon-sdk-connect';
  protocolVersion: number;
  requestId: string;
  addonId: string;
  requestedCapabilities: string[];
} {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return (
    request.type === 'optn-addon-sdk-connect' &&
    request.protocolVersion === ADDON_SDK_PROTOCOL_VERSION &&
    typeof request.requestId === 'string' &&
    request.requestId.length > 0 &&
    request.requestId.length <= 128 &&
    typeof request.addonId === 'string' &&
    request.addonId.length > 0 &&
    request.addonId.length <= 256 &&
    Array.isArray(request.requestedCapabilities) &&
    request.requestedCapabilities.length <= 64 &&
    new Set(request.requestedCapabilities).size ===
      request.requestedCapabilities.length &&
    request.requestedCapabilities.every(
      (capability) =>
        typeof capability === 'string' &&
        capability.length > 0 &&
        capability.length <= 128
    )
  );
}

export type MountedAddonIframe = {
  destroy: () => void;
  setLocale: (
    locale: AddonLocale,
    messages: Readonly<Record<string, string>>
  ) => void;
};

/**
 * Creates the sandboxed <iframe>, wires the postMessage bridge, and sends the
 * addon's bundle source once the sandbox page signals it's ready. Returns a
 * destroy() to tear everything down (removes the iframe + listener).
 *
 * Security-relevant details:
 * - sandbox="allow-scripts" WITHOUT allow-same-origin: the iframe gets an
 *   opaque origin. It cannot read this window's DOM/storage, and — because
 *   its origin is opaque/unique — even a same-origin check on our side is
 *   moot; we instead verify event.source is literally this iframe's
 *   contentWindow, so no other frame/script on the page can spoof requests.
 * - The bundle is sent as source TEXT via postMessage, not fetched by the
 *   iframe itself (connect-src 'none' in the sandbox page's CSP blocks it
 *   from making network requests of its own regardless).
 */
export function mountAddonIframe(
  options: MountAddonIframeOptions
): MountedAddonIframe {
  if (
    typeof options.sessionId !== 'string' ||
    options.sessionId.length === 0 ||
    options.sessionId.length > 256
  ) {
    throw new Error('Addon iframe requires a valid sessionId');
  }
  const { container, bundleSource, sdk, locale, localeMessages, onInitError } =
    options;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('src', SANDBOX_URL);
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  container.appendChild(iframe);

  let destroyed = false;
  let currentLocale = locale;
  let currentLocaleMessages = localeMessages;

  const postLocale = (
    nextLocale: AddonLocale,
    nextMessages: Readonly<Record<string, string>>
  ) => {
    currentLocale = nextLocale;
    currentLocaleMessages = nextMessages;
    postSandboxMessage(iframe, {
      type: 'optn-addon-locale',
      locale: nextLocale,
      messages: nextMessages,
    });
  };

  const handleMessage = (event: MessageEvent<SandboxMessage>) => {
    if (destroyed) return;
    if (event.source !== iframe.contentWindow) return; // not our sandbox
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'optn-addon-ready') {
      if (options.isSessionActive?.() === false) return;
      postSandboxMessage(iframe, {
        type: 'optn-addon-init',
        bundleSource,
        sessionId: options.sessionId,
        locale: currentLocale,
        localeMessages: currentLocaleMessages,
      });
      return;
    }

    if (data.type === 'optn-addon-init-ack') {
      if (!data.ok) onInitError?.(data.error ?? 'Addon failed to initialize');
      return;
    }

    if (data.type === 'optn-addon-sdk-connect') {
      const respond = (message: { ok: boolean; session?: object }) =>
        postSandboxMessage(iframe, {
          type: 'optn-addon-sdk-connect-response',
          protocolVersion: ADDON_SDK_PROTOCOL_VERSION,
          requestId: data.requestId,
          ...message,
        });
      if (
        options.isSessionActive?.() === false ||
        !isValidAddonConnectRequest(data) ||
        !options.onConnectRequest
      ) {
        respond({ ok: false });
        return;
      }
      void options
        .onConnectRequest({
          addonId: data.addonId,
          requestedCapabilities: data.requestedCapabilities,
        })
        .then((session) => {
          if (!session) respond({ ok: false });
          else
            respond({
              ok: true,
              session: {
                ...session,
                protocolVersion: ADDON_SDK_PROTOCOL_VERSION,
              },
            });
        })
        .catch(() => respond({ ok: false }));
      return;
    }

    if (data.type === 'optn-addon-sdk-call') {
      const { requestId, module: moduleName, method: methodName, args } = data;
      if (options.isSessionActive?.() === false) {
        postSandboxMessage(iframe, {
          type: 'optn-addon-sdk-result',
          requestId,
          ok: false,
          error: 'Add-on SDK session is not authorized',
        });
        return;
      }
      try {
        assertBoundedParams(args ?? [], `${moduleName}.${methodName}`);
      } catch (error) {
        postSandboxMessage(iframe, {
          type: 'optn-addon-sdk-result',
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : 'Invalid parameters',
        });
        return;
      }
      void dispatchAddonSdkCall(sdk, moduleName, methodName, args ?? [])
        .then((result) => {
          postSandboxMessage(iframe, {
            type: 'optn-addon-sdk-result',
            requestId,
            ok: true,
            result,
          });
        })
        .catch((err: unknown) => {
          postSandboxMessage(iframe, {
            type: 'optn-addon-sdk-result',
            requestId,
            ok: false,
            error: safeAddonWireError(err).message,
          });
        });
    }

    if (data.type === 'optn-addon-sdk-request') {
      const respond = (message: {
        ok: boolean;
        result?: unknown;
        error?: { code: string; message: string; retry: 'never' };
      }) =>
        postSandboxMessage(iframe, {
          type: 'optn-addon-sdk-response',
          protocolVersion: ADDON_SDK_PROTOCOL_VERSION,
          requestId: data.requestId,
          ...message,
        });
      if (data.protocolVersion !== ADDON_SDK_PROTOCOL_VERSION) {
        respond({
          ok: false,
          error: {
            code: 'UNSUPPORTED_VERSION',
            message: 'Unsupported add-on SDK protocol version',
            retry: 'never',
          },
        });
        return;
      }
      if (
        typeof data.requestId !== 'string' ||
        data.requestId.length === 0 ||
        data.requestId.length > 128 ||
        typeof data.method !== 'string' ||
        data.method.length === 0 ||
        data.method.length > 128
      ) {
        respond({
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Invalid add-on SDK request',
            retry: 'never',
          },
        });
        return;
      }
      if (data.sessionId !== options.sessionId) {
        respond({
          ok: false,
          error: {
            code: 'SESSION_REVOKED',
            message: 'Add-on SDK session is not authorized',
            retry: 'never',
          },
        });
        return;
      }
      if (options.isSessionActive?.() === false) {
        respond({
          ok: false,
          error: {
            code: 'SESSION_REVOKED',
            message: 'Add-on SDK session is not authorized',
            retry: 'never',
          },
        });
        return;
      }
      void dispatchAddonSdkRequest(sdk, data.method, data.params)
        .then((result) => respond({ ok: true, result }))
        .catch((err: unknown) =>
          respond({
            ok: false,
            error: safeAddonWireError(err),
          })
        );
    }
  };

  window.addEventListener('message', handleMessage);

  return {
    setLocale(nextLocale, nextMessages) {
      if (destroyed) return;
      postLocale(nextLocale, nextMessages);
    },
    destroy() {
      destroyed = true;
      window.removeEventListener('message', handleMessage);
      iframe.remove();
    },
  };
}
