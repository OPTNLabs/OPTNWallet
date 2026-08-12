// Desktop shim for @capacitor/dialog — uses native browser dialogs

export const Dialog = {
  alert: async ({ title, message }: { title?: string; message: string }) => {
    window.alert(title ? `${title}\n\n${message}` : message);
  },

  confirm: async ({
    title,
    message,
    okButtonTitle,
    cancelButtonTitle,
  }: {
    title?: string;
    message: string;
    okButtonTitle?: string;
    cancelButtonTitle?: string;
  }): Promise<{ value: boolean }> => {
    const text = title ? `${title}\n\n${message}` : message;
    void okButtonTitle;
    void cancelButtonTitle;
    return { value: window.confirm(text) };
  },

  prompt: async ({
    title,
    message,
    okButtonTitle,
    cancelButtonTitle,
    inputPlaceholder,
    inputText,
  }: {
    title?: string;
    message: string;
    okButtonTitle?: string;
    cancelButtonTitle?: string;
    inputPlaceholder?: string;
    inputText?: string;
  }): Promise<{ value: string; cancelled: boolean }> => {
    const text = title ? `${title}\n\n${message}` : message;
    void okButtonTitle;
    void cancelButtonTitle;
    const result = window.prompt(text, inputText ?? inputPlaceholder ?? '');
    return { value: result ?? '', cancelled: result === null };
  },
};
