import { invoke } from '@tauri-apps/api/core';

import { isDesktopPlatform } from './platform';

// Desktop deliberately does not use navigator.clipboard. WKWebView resolves
// writeText() and then silently drops the write, so a copy button reports
// success over a pasteboard that never changed, and readText() is
// permission-gated or absent outright. WebKitGTK (the Linux AppImage) shares
// that lineage. The native command in src-tauri/src/clipboard.rs talks to
// NSPasteboard / Win32 / X11 / Wayland directly and returns a real error when
// the write fails, instead of a promise that resolves and lies.

/** Copy text to the system clipboard. Resolves false when the copy did not happen. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (isDesktopPlatform()) {
    try {
      await invoke('clipboard_write_text', { text });
      return true;
    } catch (error) {
      console.error('[clipboard] native write failed:', error);
      return false;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyViaExecCommand(text);
  }
}

/** Read text from the system clipboard. Throws when no clipboard is reachable. */
export async function readFromClipboard(): Promise<string> {
  if (isDesktopPlatform()) {
    return invoke<string>('clipboard_read_text');
  }
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
    throw new Error('Clipboard paste is not available in this environment.');
  }
  return navigator.clipboard.readText();
}

// Browser runtimes only. Reaches the editing layer rather than the async
// Clipboard API — the same path WebKit's right-click Copy uses — so it still
// works where the async API is blocked. Deprecated but universally implemented.
function copyViaExecCommand(text: string): boolean {
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    // Off-screen rather than hidden: display:none cannot be selected, and a
    // visible textarea would scroll the page out from under the user.
    el.style.position = 'fixed';
    el.style.top = '0';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(el);
    return copied;
  } catch {
    return false;
  }
}
