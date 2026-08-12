// Desktop shim for @capacitor/clipboard — uses the Web Clipboard API

export const Clipboard = {
  write: async ({ string, url, label }: {
    string?: string;
    image?: string;
    url?: string;
    label?: string;
  }) => {
    const text = string ?? url ?? label ?? '';
    await navigator.clipboard.writeText(text);
  },
  read: async (): Promise<{ type: string; value: string }> => {
    const value = await navigator.clipboard.readText();
    return { type: 'text/plain', value };
  },
};
