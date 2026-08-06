// What can this runtime ACTUALLY talk to a hardware wallet with?
//
// Browser tab: WebHID / WebBLE / Connect iframe / camera.
// Desktop Tauri WebView: no WebHID/WebUSB/WebBLE — USB is done in Rust hidapi
// (same model as Electron Cash / Ledger Live / Trezor Suite), then TypeScript
// SDKs speak the app protocol (@ledgerhq/hw-app-btc, @trezor/protobuf).

import { isDesktopPlatform } from '../../utils/platform';

export type HardwareTransport =
  | 'webhid'
  | 'webusb'
  | 'webble'
  | 'camera'
  | 'iframe'
  | 'native-usb';

export interface TransportSupport {
  webhid: boolean;
  webusb: boolean;
  webble: boolean;
  camera: boolean;
  /** Cross-origin connect pages (browser Trezor Connect / OneKey web SDK). */
  iframe: boolean;
  /** Tauri hidapi path — Ledger / Trezor One / OneKey HID. */
  nativeUsb: boolean;
}

export function detectTransportSupport(
  nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator
): TransportSupport {
  const n = nav as
    | (Navigator & {
        hid?: unknown;
        usb?: unknown;
        bluetooth?: unknown;
      })
    | undefined;

  return {
    webhid: !!n && typeof n.hid === 'object' && n.hid !== null,
    webusb: !!n && typeof n.usb === 'object' && n.usb !== null,
    webble: !!n && typeof n.bluetooth === 'object' && n.bluetooth !== null,
    camera: !!n?.mediaDevices && typeof n.mediaDevices.getUserMedia === 'function',
    iframe: typeof window !== 'undefined',
    nativeUsb: isDesktopPlatform(),
  };
}

/** Transports each device can actually be driven over, in preference order. */
const DEVICE_TRANSPORTS: Record<string, HardwareTransport[]> = {
  ledger: ['native-usb', 'webhid', 'webble'],
  trezor: ['native-usb', 'iframe'],
  onekey: ['native-usb', 'iframe'],
  keystone: ['camera'],
};

/**
 * Why this device cannot be reached here, or null when it can.
 */
export function unsupportedReason(
  deviceType: string,
  support: TransportSupport = detectTransportSupport()
): string | null {
  const transports = DEVICE_TRANSPORTS[deviceType];
  if (!transports || transports.length === 0) return null;

  const ok = transports.some((t) => {
    if (t === 'native-usb') return support.nativeUsb;
    return support[t as keyof TransportSupport];
  });
  if (ok) return null;

  if (transports.includes('webhid') || transports.includes('native-usb')) {
    return (
      'This build cannot reach USB hardware wallets. Use the desktop app ' +
      '(native USB) or a browser with WebHID. It is not your cable or device.'
    );
  }
  if (transports.includes('camera')) {
    return 'No camera is available, so QR-based signing cannot be used here.';
  }
  return 'This build cannot reach this device yet.';
}

export function describeTransportSupport(
  support: TransportSupport = detectTransportSupport()
): string {
  return Object.entries(support)
    .map(([name, ok]) => `${name}=${ok ? 'yes' : 'NO'}`)
    .join(' ');
}
