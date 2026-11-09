import { showWalletStatus } from './copyWithFeedback';

type ExternalLinkClickEvent = {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  currentTarget: HTMLAnchorElement;
  preventDefault: () => void;
};

function hasDesktopExternalHandler(): boolean {
  if (typeof window === 'undefined') return false;
  const candidate = window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return '__TAURI__' in candidate || '__TAURI_INTERNALS__' in candidate;
}

/**
 * Open an external link from a user gesture and report popup/browser failures.
 * Tauri handles external links at the document boundary, so those clicks are
 * left alone for its system-browser adapter.
 */
export function handleExternalLinkClick(
  event: ExternalLinkClickEvent,
  failureMessage: string
): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    hasDesktopExternalHandler() ||
    typeof window === 'undefined' ||
    typeof window.open !== 'function'
  ) {
    return;
  }

  event.preventDefault();
  try {
    const opened = window.open(event.currentTarget.href, '_blank');
    if (!opened) {
      showWalletStatus(failureMessage);
      return;
    }
    try {
      opened.opener = null;
    } catch {
      // Some browser proxies expose a read-only opener; the navigation worked.
    }
  } catch {
    showWalletStatus(failureMessage);
  }
}
