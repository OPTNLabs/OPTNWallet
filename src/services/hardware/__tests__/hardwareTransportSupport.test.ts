// Desktop uses native USB (hidapi). Browser uses WebHID / iframe Connect.

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  describeTransportSupport,
  detectTransportSupport,
  unsupportedReason,
} from '../hardwareTransportSupport';

const webview2 = { mediaDevices: { getUserMedia: () => {} } } as unknown as Navigator;

const chrome = {
  hid: {},
  usb: {},
  bluetooth: {},
  mediaDevices: { getUserMedia: () => {} },
} as unknown as Navigator;

describe('hardware transport support', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a Tangem off anything that cannot tap a card', () => {
    // A card has no port and no radio to pair. One transport decides every
    // surface question, which is why no rule here names desktop or extension.
    vi.stubGlobal('window', {});
    const laptop = detectTransportSupport(chrome);
    expect(laptop.nfc).toBe(false);
    expect(unsupportedReason('tangem', laptop)).toMatch(/tapped rather than plugged/i);

    // A phone with Web NFC reaches it, and nothing else changes.
    vi.stubGlobal('NDEFReader', class {});
    const phone = detectTransportSupport(chrome);
    expect(phone.nfc).toBe(true);
    expect(unsupportedReason('tangem', phone)).toBeNull();
  });

  it('reaches a Keystone wherever there is a camera, extension included', () => {
    // What MetaMask does: scan the animated QR with the machine's webcam. No
    // driver, no cable, no vendor daemon -- so this is the device with the
    // widest reach, and the popup is exactly where that matters.
    vi.stubGlobal('window', {});
    const popup = {
      hid: {},
      usb: {},
      mediaDevices: { getUserMedia: () => {} },
    } as unknown as Navigator;
    expect(unsupportedReason('keystone', detectTransportSupport(popup))).toBeNull();

    const noCamera = { hid: {}, usb: {} } as unknown as Navigator;
    expect(unsupportedReason('keystone', detectTransportSupport(noCamera))).toMatch(
      /No camera/i
    );
  });

  it('no longer claims a browser Trezor, since connect-web was removed', () => {
    // @trezor/connect-web carried five high-severity advisories through the
    // Stellar SDK. Until the @trezor/transport WebUSB path is built, a
    // browser cannot reach a Trezor, and saying otherwise sends someone
    // hunting for a cable that was never the problem.
    vi.stubGlobal('window', {});
    const browser = detectTransportSupport(chrome);
    expect(browser.nativeUsb).toBe(false);
    expect(unsupportedReason('trezor', browser)).toMatch(/USB hardware wallets/i);

    // OneKey still works there through its own web SDK.
    expect(unsupportedReason('onekey', browser)).toBeNull();
    // ...and so does a Ledger, over WebHID.
    expect(unsupportedReason('ledger', browser)).toBeNull();
  });

  it('reports no WebHID in a WebView2-shaped runtime', () => {
    vi.stubGlobal('window', {});
    const support = detectTransportSupport(webview2);
    expect(support.webhid).toBe(false);
    expect(support.webusb).toBe(false);
    expect(support.webble).toBe(false);
  });

  it('reports WebHID where it genuinely exists', () => {
    vi.stubGlobal('window', {});
    expect(detectTransportSupport(chrome).webhid).toBe(true);
  });

  it('allows Ledger on desktop via native USB even without WebHID', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const reason = unsupportedReason('ledger', detectTransportSupport(webview2));
    expect(reason).toBeNull();
  });

  it('blocks Ledger in a pure browser without WebHID', () => {
    vi.stubGlobal('window', {});
    const reason = unsupportedReason('ledger', detectTransportSupport(webview2));
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/USB|WebHID|desktop/i);
  });

  it('allows Ledger where WebHID exists', () => {
    vi.stubGlobal('window', {});
    expect(unsupportedReason('ledger', detectTransportSupport(chrome))).toBeNull();
  });

  it('allows Trezor and OneKey on desktop via native USB', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const support = detectTransportSupport(webview2);
    expect(unsupportedReason('trezor', support)).toBeNull();
    expect(unsupportedReason('onekey', support)).toBeNull();
  });

  it('allows Keystone whenever a camera is present', () => {
    vi.stubGlobal('window', {});
    expect(unsupportedReason('keystone', detectTransportSupport(webview2))).toBeNull();
  });

  it('blocks Keystone when there is no camera', () => {
    vi.stubGlobal('window', {});
    const noCamera = {} as unknown as Navigator;
    expect(unsupportedReason('keystone', detectTransportSupport(noCamera))).toMatch(
      /camera/i
    );
  });

  it('summarises support in one line for bug reports', () => {
    vi.stubGlobal('window', {});
    expect(describeTransportSupport(detectTransportSupport(webview2))).toContain(
      'webhid=NO'
    );
  });

  it('treats an unknown device as not blocked rather than inventing a reason', () => {
    vi.stubGlobal('window', {});
    expect(unsupportedReason('somethingelse', detectTransportSupport(webview2))).toBeNull();
  });
});
