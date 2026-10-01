// The bytes a Ledger sees. Checked against Ledger's own getWalletPublicKey.js
// and bip32.js rather than against our own encoder, because agreeing with
// ourselves proves nothing about what the device accepts.

import { describe, expect, it } from 'vitest';
import {
  ADDRESS_FORMAT,
  buildGetWalletPublicKey,
  CLA_BTC,
  describeStatusWord,
  encodeBip32Path,
  INS_GET_WALLET_PUBLIC_KEY,
  parseWalletPublicKey,
} from '../ledgerBchApdu';

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('ledger BCH APDUs', () => {
  it('encodes a path as a count byte and big-endian hardened levels', () => {
    // m/44'/145'/0' — BCH's coin type. Hardened sets the high bit, so 44'
    // is 0x8000002c and 145' is 0x80000091.
    expect(hex(encodeBip32Path("44'/145'/0'"))).toBe(
      '03' + '8000002c' + '80000091' + '80000000'
    );
    // The leading m/ is accepted and means the same thing.
    expect(hex(encodeBip32Path("m/44'/145'/0'"))).toBe(
      hex(encodeBip32Path("44'/145'/0'"))
    );
    // 'h' is the other spelling of hardened.
    expect(hex(encodeBip32Path('44h/145h/0h'))).toBe(
      hex(encodeBip32Path("44'/145'/0'"))
    );
    // Unhardened levels keep the high bit clear.
    expect(hex(encodeBip32Path("44'/145'/0'/0/7"))).toBe(
      '05' + '8000002c' + '80000091' + '80000000' + '00000000' + '00000007'
    );
    // An empty path is a single zero: the master key.
    expect(hex(encodeBip32Path(''))).toBe('00');
  });

  it('refuses a path it cannot encode rather than sending nonsense', () => {
    expect(() => encodeBip32Path("44'/xyz/0'")).toThrow(/not a BIP32 path level/);
    expect(() => encodeBip32Path("44'/4294967295'/0'")).toThrow(/out of range/);
    expect(() => encodeBip32Path('0/1/2/3/4/5/6/7/8/9/10')).toThrow(/at most 10 levels/);
  });

  it('asks for cashaddr, because a legacy address is a real address nobody uses', () => {
    // A Ledger handed a BCH path and asked for the default format returns a
    // legacy address on the same chain. Nothing errors; the user simply sees
    // an address no modern Bitcoin Cash wallet shows.
    expect(ADDRESS_FORMAT.cashaddr).toBe(3);

    const apdu = buildGetWalletPublicKey("44'/145'/0'");
    expect(apdu.cla).toBe(CLA_BTC);
    expect(apdu.cla).toBe(0xe0);
    expect(apdu.ins).toBe(INS_GET_WALLET_PUBLIC_KEY);
    expect(apdu.ins).toBe(0x40);
    expect(apdu.p1).toBe(0); // no on-device display by default
    expect(apdu.p2).toBe(3); // cashaddr
    expect(hex(apdu.data)).toBe('03' + '8000002c' + '80000091' + '80000000');
  });

  it('sets P1 when the address must be shown on the device', () => {
    // The only way a user can tell the address on screen is the one the
    // device derived, so it is a distinct request rather than a UI flourish.
    expect(buildGetWalletPublicKey("44'/145'/0'", { verify: true }).p1).toBe(1);
    expect(buildGetWalletPublicKey("44'/145'/0'", { verify: false }).p1).toBe(0);
  });

  it('reads back a reply the device would send', () => {
    const publicKey = new Uint8Array(65).fill(0xab);
    publicKey[0] = 0x04;
    const address = 'bchtest:qq0000000000000000000000000000000000000000';
    const addressBytes = new TextEncoder().encode(address);
    const chainCode = new Uint8Array(32).fill(0xcd);

    const reply = new Uint8Array([
      publicKey.length,
      ...publicKey,
      addressBytes.length,
      ...addressBytes,
      ...chainCode,
    ]);

    const parsed = parseWalletPublicKey(reply);
    expect(parsed.publicKey).toBe(hex(publicKey));
    expect(parsed.address).toBe(address);
    expect(parsed.chainCode).toBe(hex(chainCode));
  });

  it('refuses a truncated reply instead of returning a short address', () => {
    // A reply cut short would otherwise yield an address that still looks
    // like one, and an address is the last thing worth guessing at.
    const publicKey = new Uint8Array(65).fill(0x02);
    const addressBytes = new TextEncoder().encode('bchtest:qq00');
    const full = new Uint8Array([
      publicKey.length,
      ...publicKey,
      addressBytes.length,
      ...addressBytes,
      ...new Uint8Array(32),
    ]);

    for (const cut of [0, 1, 10, 66, 70, full.length - 1]) {
      expect(() => parseWalletPublicKey(full.subarray(0, cut))).toThrow();
    }
    expect(() => parseWalletPublicKey(full)).not.toThrow();
  });

  it('turns a status word into something the user can act on', () => {
    expect(describeStatusWord(0x9000)).toBeNull();
    expect(describeStatusWord(0x6985)).toMatch(/declined/i);
    expect(describeStatusWord(0x5515)).toMatch(/locked/i);
    expect(describeStatusWord(0x6b0c)).toMatch(/locked/i);
    // The one that actually catches people: the Bitcoin app is open, not
    // Bitcoin Cash, and the message has to say which.
    expect(describeStatusWord(0x6a80)).toMatch(/Bitcoin Cash app/);
    expect(describeStatusWord(0x6a80)).toMatch(/not Bitcoin\./);
    expect(describeStatusWord(0x6d00)).toMatch(/Bitcoin Cash app/);
    // An unknown code still names itself rather than vanishing.
    expect(describeStatusWord(0x1234)).toMatch(/0x1234/);
  });
});
