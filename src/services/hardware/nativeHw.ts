/**
 * Native USB HID via Tauri (Electron Cash / Suite / Live model).
 * WebView has no WebHID — all device I/O goes through Rust hidapi.
 */

import { isDesktopPlatform } from '../../utils/platform';

export type HwFamily = 'ledger' | 'trezor' | 'onekey' | 'unknown';

export type HwDeviceInfo = {
  path: string;
  vendor_id: number;
  product_id: number;
  product: string | null;
  manufacturer: string | null;
  family: HwFamily;
  interface_number: number;
  usage_page: number;
};

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(cmd, args);
}

export function canUseNativeHw(): boolean {
  return isDesktopPlatform();
}

export async function hwEnumerate(): Promise<HwDeviceInfo[]> {
  return invoke<HwDeviceInfo[]>('hw_enumerate');
}

export async function hwOpen(path: string, family?: HwFamily): Promise<number> {
  return invoke<number>('hw_open', { path, family: family ?? null });
}

export async function hwClose(sessionId: number): Promise<void> {
  await invoke('hw_close', { sessionId });
}

export async function hwWrite(sessionId: number, dataHex: string): Promise<void> {
  await invoke('hw_write', { sessionId, dataHex });
}

export async function hwRead(sessionId: number, timeoutMs = 5000): Promise<string> {
  return invoke<string>('hw_read', { sessionId, timeoutMs });
}

export async function hwLedgerOpen(path?: string): Promise<number> {
  return invoke<number>('hw_ledger_open', { path: path ?? null });
}

export async function hwLedgerExchange(
  sessionId: number,
  apduHex: string
): Promise<string> {
  return invoke<string>('hw_ledger_exchange', { sessionId, apduHex });
}

export async function findFirstDevice(
  family: HwFamily
): Promise<HwDeviceInfo | null> {
  const list = await hwEnumerate();
  return list.find((d) => d.family === family) ?? null;
}

/** trezorlib WebUsbTransport — Safe 5 / Model T over libusb (not HID). */
export type TrezorWebUsbInfo = {
  path: string;
  vendor_id: number;
  product_id: number;
  product: string | null;
  manufacturer: string | null;
  bus: number;
  address: number;
};

export async function trezorWebUsbEnumerate(): Promise<TrezorWebUsbInfo[]> {
  return invoke<TrezorWebUsbInfo[]>('trezor_webusb_enumerate');
}

export async function trezorWebUsbOpen(path?: string): Promise<number> {
  return invoke<number>('trezor_webusb_open', { path: path ?? null });
}

export async function trezorWebUsbClose(sessionId: number): Promise<void> {
  await invoke('trezor_webusb_close', { sessionId });
}

export async function trezorWebUsbWrite(
  sessionId: number,
  dataHex: string
): Promise<void> {
  await invoke('trezor_webusb_write', { sessionId, dataHex });
}

export async function trezorWebUsbRead(
  sessionId: number,
  timeoutMs = 120_000
): Promise<string> {
  return invoke<string>('trezor_webusb_read', {
    sessionId,
    timeoutMs,
  });
}
