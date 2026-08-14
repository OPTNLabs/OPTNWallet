/**
 * Ledger Transport that uses Tauri hidapi APDU exchange (native USB).
 * Drop-in for @ledgerhq/hw-transport so @ledgerhq/hw-app-btc works unchanged.
 */

import Transport from '@ledgerhq/hw-transport';
import {
  canUseNativeHw,
  hwClose,
  hwLedgerExchange,
  hwLedgerOpen,
} from './nativeHw';

function hexToBuf(hex: string): Buffer {
  const clean = hex.replace(/^0x/, '');
  return Buffer.from(clean, 'hex');
}

function bufToHex(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('hex');
}

export default class LedgerTransportNative extends Transport {
  private sessionId: number | null = null;

  static async isSupported(): Promise<boolean> {
    return canUseNativeHw();
  }

  static async list(): Promise<string[]> {
    return ['native-ledger'];
  }

  static async open(_descriptor?: unknown): Promise<LedgerTransportNative> {
    void _descriptor; // WebUSB-shaped API; native open needs no device descriptor
    const t = new LedgerTransportNative();
    t.sessionId = await hwLedgerOpen();
    return t;
  }

  async exchange(apdu: Buffer): Promise<Buffer> {
    if (this.sessionId == null) {
      throw new Error('Ledger native transport is not open');
    }
    const respHex = await hwLedgerExchange(this.sessionId, bufToHex(apdu));
    return hexToBuf(respHex);
  }

  async close(): Promise<void> {
    if (this.sessionId != null) {
      try {
        await hwClose(this.sessionId);
      } catch {
        /* ignore */
      }
      this.sessionId = null;
    }
  }
}
