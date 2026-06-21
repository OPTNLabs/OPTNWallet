// Desktop shim for @capacitor/barcode-scanner
// Uses a file-upload dialog + jsqr (already in devDeps) to decode QR from image.
// Falls back gracefully if no file is selected.

export const CapacitorBarcodeScannerTypeHint = {
  ALL: 17,
  QR_CODE: 0,
  AZTEC: 1,
  CODABAR: 2,
  CODE_39: 3,
  CODE_93: 4,
  CODE_128: 5,
  DATA_MATRIX: 6,
  EAN_8: 7,
  EAN_13: 8,
  ITF: 9,
  MAXICODE: 10,
  PDF_417: 11,
  RSS_14: 12,
  RSS_EXPANDED: 13,
  UPC_A: 14,
  UPC_E: 15,
  UPC_EAN_EXTENSION: 16,
} as const;

export type CapacitorBarcodeScannerOptions = {
  hint?: number;
  scanInstructions?: string;
  scanButton?: boolean;
  scanText?: string;
  cameraDirection?: number;
  scanOrientation?: number;
  android?: object;
  web?: object;
};

export type CapacitorBarcodeScannerScanResult = {
  ScanResult: string;
};

function scanQRFromFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target?.result as string;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // Dynamic import jsqr — it's in devDependencies
        import('jsqr').then(({ default: jsQR }) => {
          const code = jsQR(imageData.data, imageData.width, imageData.height);
          if (code) {
            resolve(code.data);
          } else {
            reject(new Error('No QR code found in image'));
          }
        });
      };
      img.onerror = () => reject(new Error('Could not load image'));
      img.src = dataUrl;
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function openFilePicker(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    document.body.appendChild(input);
    input.click();
    setTimeout(() => {
      if (input.parentNode) input.parentNode.removeChild(input);
    }, 60000);
  });
}

export const CapacitorBarcodeScanner = {
  scanBarcode: async (
    options?: CapacitorBarcodeScannerOptions
  ): Promise<CapacitorBarcodeScannerScanResult> => {
    void options;
    const file = await openFilePicker();
    if (!file) {
      throw new Error('No file selected');
    }
    const result = await scanQRFromFile(file);
    return { ScanResult: result };
  },
};
