import { translate } from '../i18n/translate';
import type { TranslationKey } from '../i18n/resources';
import { detectSupportedLocale } from '../i18n/types';
import { Capacitor } from '@capacitor/core';
import { Toast } from '@capacitor/toast';
import { copyToClipboard } from './clipboard';

let message: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Presentation fallback also works without Capacitor's PWA custom elements. */
export function showWalletStatus(text: string): void {
  if (typeof document === 'undefined') return;
  if (timer) clearTimeout(timer);
  message?.remove();
  const node = document.createElement('div');
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.textContent = text;
  node.className = 'wallet-card';
  node.style.cssText =
    'position:fixed;bottom:calc(env(safe-area-inset-bottom,0px) + 80px);left:50%;transform:translateX(-50%);z-index:2147483647;padding:12px 20px;max-width:calc(100vw - 32px);overflow-wrap:anywhere;pointer-events:none';
  document.body.appendChild(node);
  message = node;
  timer = setTimeout(() => {
    node.remove();
    if (message === node) message = null;
  }, 3500);
}

/** Show transient feedback on native and browser/desktop surfaces alike. */
export async function showWalletNotification(text: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    try {
      await Toast.show({ text });
      return;
    } catch {
      /* Fall through to the accessible wallet-owned presenter. */
    }
  }
  showWalletStatus(text);
}

/** Notification failure never changes the outcome of the clipboard operation. */
export async function copyWithFeedback(
  text: string,
  successMessageKey: TranslationKey = 'receive.copied'
): Promise<boolean> {
  const copied = await copyToClipboard(text);
  const locale = detectSupportedLocale(
    typeof document === 'undefined' ? 'en' : document.documentElement.lang
  );
  const label = translate(
    locale,
    copied ? successMessageKey : 'receive.copyFailed'
  );
  try {
    await showWalletNotification(label);
  } catch {
    // Clipboard success/failure is authoritative even if every presenter fails.
  }
  return copied;
}
