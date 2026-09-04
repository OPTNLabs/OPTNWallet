// The DMK session layer, driven by a fake device. No hardware, but every byte
// that would reach one is checked, and so is every refusal it can answer with.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearActiveSession,
  dmkAvailability,
  dmkGetWalletPublicKey,
  encodeApdu,
  hasActiveSession,
  setActiveSession,
  statusOf,
} from '../LedgerDmkSession';

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A device that answers one reply and records what it was asked. */
function fakeDevice(reply: { data: Uint8Array; status: number }) {
  const sent: Uint8Array[] = [];
  return {
    sent,
    dmk: {
      async sendApdu({ apdu }: { sessionId: string; apdu: Uint8Array }) {
        sent.push(apdu);
        return {
          data: reply.data,
          statusCode: new Uint8Array([reply.status >> 8, reply.status & 0xff]),
        };
      },
    },
  };
}

function walletReply(address: string) {
  const publicKey = new Uint8Array(65).fill(0x02);
  const addressBytes = new TextEncoder().encode(address);
  return new Uint8Array([
    publicKey.length,
    ...publicKey,
    addressBytes.length,
    ...addressBytes,
    ...new Uint8Array(32).fill(0x11),
  ]);
}

describe('ledger DMK session', () => {
  beforeEach(() => clearActiveSession());

  it('reports what the runtime can reach rather than what the platform is', () => {
    // A desktop WebView has neither, and reaches a Ledger through Rust.
    const webview = dmkAvailability({} as Navigator);
    expect(webview.transports).toEqual([]);
    expect(webview.unavailableReason).toMatch(/neither WebHID nor Web Bluetooth/);

    const browser = dmkAvailability({ hid: {}, bluetooth: {} } as unknown as Navigator);
    expect(browser.transports).toEqual(['web-hid', 'web-ble']);
    expect(browser.unavailableReason).toBeNull();

    // An extension popup usually has WebHID and no Bluetooth.
    const popup = dmkAvailability({ hid: {} } as unknown as Navigator);
    expect(popup.transports).toEqual(['web-hid']);
    expect(popup.unavailableReason).toBeNull();
  });

  it('serialises an APDU as class, instruction, parameters, length, body', () => {
    expect(
      hex(encodeApdu({ cla: 0xe0, ins: 0x40, p1: 0, p2: 3, data: new Uint8Array([1, 2]) }))
    ).toBe('e04000030201' + '02');

    // An empty body still carries its zero length.
    expect(hex(encodeApdu({ cla: 0xe0, ins: 0x40, p1: 1, p2: 3, data: new Uint8Array() })))
      .toBe('e0400103' + '00');

    expect(() =>
      encodeApdu({ cla: 0, ins: 0, p1: 0, p2: 0, data: new Uint8Array(256) })
    ).toThrow(/at most 255 bytes/);
  });

  it('reads the status word, and refuses a reply that has none', () => {
    expect(statusOf(new Uint8Array([0x90, 0x00]))).toBe(0x9000);
    expect(statusOf(new Uint8Array([0x69, 0x85]))).toBe(0x6985);
    expect(() => statusOf(new Uint8Array([0x90]))).toThrow(/no status word/);
  });

  it('sends the cashaddr request and reads the account back', async () => {
    const address = 'bchtest:qq0000000000000000000000000000000000000000';
    const device = fakeDevice({ data: walletReply(address), status: 0x9000 });
    setActiveSession(device.dmk, 'session-1');
    expect(hasActiveSession()).toBe(true);

    const account = await dmkGetWalletPublicKey("44'/145'/0'");
    expect(account.address).toBe(address);
    expect(account.publicKey).toHaveLength(130);
    expect(account.chainCode).toHaveLength(64);

    // The bytes that actually went to the device: cashaddr (p2 = 3) over
    // m/44'/145'/0', not a legacy address on the same chain.
    expect(hex(device.sent[0])).toBe(
      'e0' + '40' + '00' + '03' + '0d' + '03' + '8000002c' + '80000091' + '80000000'
    );
  });

  it('asks the device to display the address when told to', async () => {
    const device = fakeDevice({ data: walletReply('bchtest:qq00'), status: 0x9000 });
    setActiveSession(device.dmk, 'session-1');
    await dmkGetWalletPublicKey("44'/145'/0'", { verify: true });
    expect(device.sent[0][2]).toBe(1); // P1
  });

  it('gives the device its own reason rather than "failed"', async () => {
    const locked = fakeDevice({ data: new Uint8Array(), status: 0x5515 });
    setActiveSession(locked.dmk, 'session-1');
    await expect(dmkGetWalletPublicKey("44'/145'/0'")).rejects.toThrow(/locked/i);

    const wrongApp = fakeDevice({ data: new Uint8Array(), status: 0x6a80 });
    setActiveSession(wrongApp.dmk, 'session-1');
    await expect(dmkGetWalletPublicKey("44'/145'/0'")).rejects.toThrow(
      /Bitcoin Cash app/
    );

    const declined = fakeDevice({ data: new Uint8Array(), status: 0x6985 });
    setActiveSession(declined.dmk, 'session-1');
    await expect(dmkGetWalletPublicKey("44'/145'/0'")).rejects.toThrow(/declined/i);
  });

  it('refuses to ask a device that is not connected', async () => {
    clearActiveSession();
    expect(hasActiveSession()).toBe(false);
    await expect(dmkGetWalletPublicKey("44'/145'/0'")).rejects.toThrow(
      /No Ledger session is open/
    );
  });
});
