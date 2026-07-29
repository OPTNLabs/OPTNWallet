// Host-side bridge for 'iframe-bundle' addons (see public/addon-sandbox.html
// for the sandboxed side). Split into a pure dispatcher (testable without a
// real DOM/iframe) and a thin DOM-mounting layer, so the security-relevant
// logic — which SDK call an addon is actually allowed to make — is covered
// by a real unit test rather than only by manual iframe testing.
import type { AddonSDK } from '../AddonsSDK';

const SANDBOX_URL = '/addon-sandbox.html';

/**
 * Dispatch one {module, method, args} request from an addon against an
 * ALREADY capability-scoped AddonSDK instance (built by createAddonSDK — the
 * exact same object declarative apps use). This function does not implement
 * any authorization itself: every capability check already lives inside the
 * sdk's own methods (see AddonsSDK.ts's authorizeCapability calls), so an
 * addon asking for a module/method it wasn't granted throws from the sdk
 * call itself, not from anything here.
 */
export async function dispatchAddonSdkCall(
  sdk: AddonSDK,
  moduleName: string,
  methodName: string,
  args: unknown[]
): Promise<unknown> {
  const sdkRecord = sdk as unknown as Record<string, Record<string, unknown> | undefined>;
  const mod = sdkRecord[moduleName];
  if (!mod || typeof mod !== 'object') {
    throw new Error(`Addon requested unknown SDK module: ${moduleName}`);
  }
  const fn = mod[methodName];
  if (typeof fn !== 'function') {
    throw new Error(`Addon requested unknown SDK method: ${moduleName}.${methodName}`);
  }
  return (fn as (...a: unknown[]) => unknown).apply(mod, args);
}

type SandboxMessage =
  | { type: 'optn-addon-ready' }
  | { type: 'optn-addon-init-ack'; ok: boolean; error?: string }
  | { type: 'optn-addon-sdk-call'; requestId: string; module: string; method: string; args: unknown[] };

export type MountAddonIframeOptions = {
  container: HTMLElement;
  bundleSource: string;
  sdk: AddonSDK;
  onInitError?: (message: string) => void;
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
export function mountAddonIframe(options: MountAddonIframeOptions): { destroy: () => void } {
  const { container, bundleSource, sdk, onInitError } = options;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('src', SANDBOX_URL);
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  container.appendChild(iframe);

  let destroyed = false;

  const handleMessage = (event: MessageEvent<SandboxMessage>) => {
    if (destroyed) return;
    if (event.source !== iframe.contentWindow) return; // not our sandbox
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'optn-addon-ready') {
      iframe.contentWindow?.postMessage(
        { type: 'optn-addon-init', bundleSource },
        '*'
      );
      return;
    }

    if (data.type === 'optn-addon-init-ack') {
      if (!data.ok) onInitError?.(data.error ?? 'Addon failed to initialize');
      return;
    }

    if (data.type === 'optn-addon-sdk-call') {
      const { requestId, module: moduleName, method: methodName, args } = data;
      void dispatchAddonSdkCall(sdk, moduleName, methodName, args ?? [])
        .then((result) => {
          iframe.contentWindow?.postMessage(
            { type: 'optn-addon-sdk-result', requestId, ok: true, result },
            '*'
          );
        })
        .catch((err: unknown) => {
          iframe.contentWindow?.postMessage(
            {
              type: 'optn-addon-sdk-result',
              requestId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            '*'
          );
        });
    }
  };

  window.addEventListener('message', handleMessage);

  return {
    destroy() {
      destroyed = true;
      window.removeEventListener('message', handleMessage);
      iframe.remove();
    },
  };
}
