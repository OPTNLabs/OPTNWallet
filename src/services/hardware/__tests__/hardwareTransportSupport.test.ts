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
