// The reason "every hardware wallet failed" on the desktop build.
//
// Not four separate device bugs: the desktop WebView (WebView2) implements
// none of the browser device APIs these integrations are built on. These tests
// pin that diagnosis so a future change that claims to fix hardware support has
// to actually provide a transport rather than retry the same dead one.

import { describe, expect, it } from 'vitest';
import {
  describeTransportSupport,
  detectTransportSupport,
  unsupportedReason,
} from '../hardwareTransportSupport';

/** WebView2: a real Navigator, with no hid/usb/bluetooth on it. */
const webview2 = { mediaDevices: { getUserMedia: () => {} } } as unknown as Navigator;

/** A browser that does expose the device APIs. */
const chrome = {
  hid: {},
  usb: {},
  bluetooth: {},
  mediaDevices: { getUserMedia: () => {} },
} as unknown as Navigator;

describe('hardware transport support', () => {
  it('reports no WebHID in a WebView2-shaped runtime', () => {
    const support = detectTransportSupport(webview2);
    expect(support.webhid).toBe(false);
    expect(support.webusb).toBe(false);
    expect(support.webble).toBe(false);
  });

  it('reports WebHID where it genuinely exists', () => {
    expect(detectTransportSupport(chrome).webhid).toBe(true);
  });

  it('blocks Ledger on the desktop WebView, and says why without blaming the device', () => {
    const reason = unsupportedReason('ledger', detectTransportSupport(webview2));
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/WebHID/);
    // The previous behaviour was a generic transport error, which reads as a
    // bad cable or a locked device and sends people to re-plug hardware that
    // was never the problem.
    expect(reason).toMatch(/not your cable|not your device/i);
  });

  it('allows Ledger where WebHID exists', () => {
    expect(unsupportedReason('ledger', detectTransportSupport(chrome))).toBeNull();
  });

  it('allows Keystone whenever a camera is present, since it is air-gapped', () => {
    // Keystone needs no USB at all — QR in, QR out. It must not be blocked by
    // the missing device APIs.
    expect(unsupportedReason('keystone', detectTransportSupport(webview2))).toBeNull();
  });

  it('blocks Keystone when there is no camera', () => {
    const noCamera = {} as unknown as Navigator;
    expect(unsupportedReason('keystone', detectTransportSupport(noCamera))).toMatch(
      /camera/i
    );
  });

  it('summarises support in one line for bug reports', () => {
    expect(describeTransportSupport(detectTransportSupport(webview2))).toContain(
      'webhid=NO'
    );
  });

  it('treats an unknown device as not blocked rather than inventing a reason', () => {
    expect(unsupportedReason('somethingelse', detectTransportSupport(webview2))).toBeNull();
  });
});
