/**
 * Ledger Bitcoin Cash APDUs, built by hand on top of the Device Management Kit.
 *
 * Ledger deprecated the whole LedgerJS family — `hw-app-*` and `hw-transport-*`
 * — in September 2026 and points everyone at the Device Management Kit. There
 * is a signer kit per chain (`device-signer-kit-ethereum`, `-solana`, `-zcash`,
 * `-xrp` and nine more) but **none for Bitcoin Cash**, and the Bitcoin one
 * cannot stand in for it. Three ways of checking agree:
 *
 * - `@ledgerhq/device-signer-kit-bitcoin@1.3.3` contains no occurrence of
 *   "bitcoin cash", "cashaddr", "forkid" or "additionals".
 * - Its `SignerBtcBuilder` takes only `{ dmk, sessionId }`. There is no
 *   currency, app or additionals option to point it at another chain.
 * - Its descriptor templates are `pkh`, `sh(wpkh(..))`, `wpkh` and `tr` — the
 *   Bitcoin app's wallet-policy protocol, which the Bitcoin Cash device app
 *   does not speak. Our own code already said so: `hw-app-btc` routes
 *   `currency: 'bch'` to its `BtcOld` implementation, the *legacy* protocol.
 *
 * So the migration is not "swap one library for another". It is: take the
 * maintained, cross-platform half — DMK's discovery, sessions and transports —
 * and write the small app-binder Ledger did not write for us. That is the same
 * shape their own signer kits have; it is not a fork of the deprecated library,
 * and none of `hw-app-btc` is copied here.
 *
 * Everything in this file is a pure function over bytes, so it is tested
 * without a device. The wire format is taken from Ledger's own
 * `getWalletPublicKey.js` and `bip32.js`, which is what the wallet drives
 * successfully today.
 */

/** Bitcoin application class byte. */
export const CLA_BTC = 0xe0;
/** GET WALLET PUBLIC KEY. */
export const INS_GET_WALLET_PUBLIC_KEY = 0x40;

/**
 * Address encodings the app can return.
 *
 * `cashaddr` is 3, and it is the only one this wallet asks for: a Ledger
 * handed a BCH path and asked for a legacy address will happily produce one,
 * and it is an address on the same chain that no modern Bitcoin Cash wallet
 * shows. Sending funds to it is not an error anyone sees until later.
 */
export const ADDRESS_FORMAT = {
  legacy: 0,
  p2sh: 1,
  bech32: 2,
  cashaddr: 3,
} as const;

export type AddressFormat = keyof typeof ADDRESS_FORMAT;

export interface Apdu {
  cla: number;
  ins: number;
  p1: number;
  p2: number;
  data: Uint8Array;
}

export interface WalletPublicKey {
  /** Uncompressed public key, hex. */
  publicKey: string;
  /** The address the device rendered, in the format that was asked for. */
  address: string;
  /** BIP32 chain code, hex. */
  chainCode: string;
}

/**
 * Encode a BIP32 path the way the Bitcoin app expects: a count byte, then one
 * big-endian u32 per level, hardened levels having the high bit set.
 *
 * Accepts a path with or without a leading `m/`. An empty path is a single
 * zero byte, which is what asks the device for the master key.
 */
export function encodeBip32Path(path: string): Uint8Array {
  const trimmed = path.trim().replace(/^m\//, '').replace(/\/+$/, '');
  const levels = trimmed === '' ? [] : trimmed.split('/');
  if (levels.length > 10) {
    // The app rejects longer paths, and saying so here is a better error than
    // a 0x6a80 from the device.
    throw new Error(`a BIP32 path has at most 10 levels, got ${levels.length}`);
  }

  const out = new Uint8Array(1 + levels.length * 4);
  out[0] = levels.length;
  levels.forEach((level, index) => {
    const hardened = level.endsWith("'") || level.endsWith('h');
    const digits = hardened ? level.slice(0, -1) : level;
    if (!/^\d+$/.test(digits)) {
      throw new Error(`'${level}' is not a BIP32 path level`);
    }
    const value = Number(digits);
    if (value > 0x7fffffff) {
      throw new Error(`path level ${level} is out of range`);
    }
    const encoded = hardened ? (value + 0x80000000) >>> 0 : value >>> 0;
    const at = 1 + index * 4;
    out[at] = (encoded >>> 24) & 0xff;
    out[at + 1] = (encoded >>> 16) & 0xff;
    out[at + 2] = (encoded >>> 8) & 0xff;
    out[at + 3] = encoded & 0xff;
  });
  return out;
}

/**
 * Build the GET WALLET PUBLIC KEY command.
 *
 * `verify` asks the device to show the address on its screen, which is the
 * only way a user can tell that the address on the computer is the one the
 * device derived.
 */
export function buildGetWalletPublicKey(
  path: string,
  options: { verify?: boolean; format?: AddressFormat } = {}
): Apdu {
  const { verify = false, format = 'cashaddr' } = options;
  return {
    cla: CLA_BTC,
    ins: INS_GET_WALLET_PUBLIC_KEY,
    p1: verify ? 1 : 0,
    p2: ADDRESS_FORMAT[format],
    data: encodeBip32Path(path),
  };
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Read the response: a length-prefixed public key, a length-prefixed ASCII
 * address, then 32 bytes of chain code.
 *
 * Every length is checked against what is actually there. A truncated reply
 * that was read optimistically would produce a short address that still looks
 * like one, and an address is the last thing worth guessing at.
 */
export function parseWalletPublicKey(response: Uint8Array): WalletPublicKey {
  let offset = 0;
  const need = (count: number, what: string) => {
    if (offset + count > response.length) {
      throw new Error(
        `the device's reply ended in the middle of its ${what} ` +
          `(${response.length} bytes)`
      );
    }
  };

  need(1, 'public key length');
  const publicKeyLength = response[offset];
  offset += 1;
  need(publicKeyLength, 'public key');
  const publicKey = toHex(response.subarray(offset, offset + publicKeyLength));
  offset += publicKeyLength;

  need(1, 'address length');
  const addressLength = response[offset];
  offset += 1;
  need(addressLength, 'address');
  const address = new TextDecoder('ascii').decode(
    response.subarray(offset, offset + addressLength)
  );
  offset += addressLength;

  need(32, 'chain code');
  const chainCode = toHex(response.subarray(offset, offset + 32));

  if (publicKeyLength === 0 || addressLength === 0) {
    throw new Error('the device returned an empty public key or address');
  }
  return { publicKey, address, chainCode };
}

/**
 * Turn a status word into something a person can act on.
 *
 * 0x9000 is success. The rest are the ones that actually happen, and each has
 * a different thing for the user to do — which is the whole reason not to show
 * the raw code.
 */
export function describeStatusWord(status: number): string | null {
  switch (status) {
    case 0x9000:
      return null;
    case 0x6985:
      return 'You declined that on the device.';
    case 0x5515:
    case 0x6b0c:
      return 'The Ledger is locked. Enter its PIN and try again.';
    case 0x6a80:
    case 0x6a86:
      return 'The device rejected the request. Open the Bitcoin Cash app on it, not Bitcoin.';
    case 0x6d00:
    case 0x6e00:
      return 'The app open on the device does not understand that request. Open the Bitcoin Cash app.';
    case 0x6f00:
      return 'The device reported an internal error. Unplug it and try again.';
    default:
      return `The device refused the request (status 0x${status
        .toString(16)
        .padStart(4, '0')}).`;
  }
}
