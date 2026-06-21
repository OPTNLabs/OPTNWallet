// Desktop shim for @capacitor/camera — uses file input to pick an image

export const CameraResultType = {
  Uri: 'uri',
  Base64: 'base64',
  DataUrl: 'dataUrl',
} as const;

export const CameraSource = {
  Prompt: 'PROMPT',
  Camera: 'CAMERA',
  Photos: 'PHOTOS',
} as const;

export const Camera = {
  getPhoto: async (options?: {
    resultType?: string;
    quality?: number;
    allowEditing?: boolean;
    source?: string;
  }): Promise<{ base64String?: string; dataUrl?: string; path?: string; webPath?: string; format: string; saved: boolean }> => {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) { reject(new Error('No file selected')); return; }
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result as string;
          const base64 = dataUrl.split(',')[1];
          resolve({
            base64String: options?.resultType === 'base64' ? base64 : undefined,
            dataUrl: options?.resultType === 'dataUrl' ? dataUrl : undefined,
            webPath: dataUrl,
            format: file.type.split('/')[1] ?? 'jpeg',
            saved: false,
          });
        };
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
      };
      document.body.appendChild(input);
      input.click();
      setTimeout(() => { if (input.parentNode) input.parentNode.removeChild(input); }, 60000);
    });
  },

  checkPermissions: async () => ({ camera: 'granted' as const, photos: 'granted' as const }),
  requestPermissions: async () => ({ camera: 'granted' as const, photos: 'granted' as const }),
};
