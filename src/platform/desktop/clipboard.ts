// Desktop shim for @capacitor/clipboard.
//
// Routes through the shared helper, which uses the native Tauri command rather
// than navigator.clipboard — WKWebView silently drops programmatic writes and
// gates reads. See src/utils/clipboard.ts and src-tauri/src/clipboard.rs.

import { copyToClipboard, readFromClipboard } from '../../utils/clipboard';

export const Clipboard = {
  write: async ({ string, url, label }: {
    string?: string;
    image?: string;
    url?: string;
    label?: string;
  }) => {
    const text = string ?? url ?? label ?? '';
    // Capacitor's write() resolves void on success and throws on failure;
    // preserve that contract so callers see a real error instead of a
    // silent no-op.
    const copied = await copyToClipboard(text);
    if (!copied) throw new Error('Could not write to the clipboard.');
  },
  read: async (): Promise<{ type: string; value: string }> => {
    const value = await readFromClipboard();
    return { type: 'text/plain', value };
  },
};
