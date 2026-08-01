// What can this runtime ACTUALLY talk to a hardware wallet with?
//
// Every hardware wallet integration here is built on a browser device API:
// Ledger on WebHID (`navigator.hid`), Trezor and OneKey on a cross-origin
// iframe to their hosted connect page, Keystone on the camera. Those are the
// right choices in a browser tab. The desktop build is not a browser tab — it
// is a WebView2 window, and WebView2 does not implement the WebHID/WebUSB/Web
// Bluetooth device APIs at all.
//
// This is the same wall CashFusion hit: `FusionStatusService` says a WebView
// "can only open HTTP/WebSocket connections, so the frontend cannot speak this
// protocol at any level", and the answer there was to do the real work in Rust
// and expose a command. Hardware wallets need the same answer — which is also
// how every desktop wallet that works does it (Electron Cash talks to devices
// through hidapi/trezorlib natively, not through a browser API).
//
// Until that native path exists, the least this can do is say so out loud. A
// missing capability currently surfaces as a device that simply never connects,
// which is indistinguishable from a broken cable or a wrong PIN.

export type HardwareTransport = 'webhid' | 'webusb' | 'webble' | 'camera' | 'iframe';

export interface TransportSupport {
  webhid: boolean;
  webusb: boolean;
  webble: boolean;
  camera: boolean;
  /** Cross-origin connect pages (Trezor Connect, OneKey) need a real browsing
   *  context. Present in a WebView, but the popup/permission flow they rely on
   *  is not reliably available, so this is "maybe", not "yes". */
  iframe: boolean;
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
  };
}

/** Transports each device can actually be driven over, in preference order. */
const DEVICE_TRANSPORTS: Record<string, HardwareTransport[]> = {
  ledger: ['webhid', 'webble'],
  trezor: ['iframe'],
  onekey: ['iframe'],
  keystone: ['camera'],
};

/**
 * Why this device cannot be reached here, or null when it can.
 *
 * Phrased for the person holding the device: it names the missing capability
 * and does not imply the device or the cable is at fault.
 */
export function unsupportedReason(
  deviceType: string,
  support: TransportSupport = detectTransportSupport()
): string | null {
  const transports = DEVICE_TRANSPORTS[deviceType];
  if (!transports || transports.length === 0) return null;
  if (transports.some((t) => support[t])) return null;

  if (transports.includes('webhid')) {
    return (
      'This desktop build cannot reach USB devices: its WebView does not ' +
      'provide WebHID. Native USB support has to be added in the Rust layer ' +
      'before Ledger can connect here. It is not your cable or your device.'
    );
  }
  if (transports.includes('camera')) {
    return 'No camera is available, so QR-based signing cannot be used here.';
  }
  return 'This desktop build cannot reach this device yet.';
}

/** One-line summary for logs and bug reports. */
export function describeTransportSupport(
  support: TransportSupport = detectTransportSupport()
): string {
  return Object.entries(support)
    .map(([name, ok]) => `${name}=${ok ? 'yes' : 'NO'}`)
    .join(' ');
}
