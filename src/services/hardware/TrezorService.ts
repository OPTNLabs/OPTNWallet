/**
 * Trezor service.
 *
 * Desktop (Tauri): native USB HID + @trezor/protobuf (Suite / Electron Cash model).
 * Browser:         not yet wired. See `browserNotWired` below.
 *
 * This used to reach for @trezor/connect-web in the browser. That package
 * pulls @trezor/connect, which pulls @trezor/blockchain-link, which pulls the
 * whole @stellar/stellar-sdk, which pulls a `toml` parser carrying two
 * high-severity advisories with no fixed release. It was the only source of
 * every high-severity finding in this repository's production dependency tree,
 * for a Bitcoin Cash wallet that has no use for Stellar.
 *
 * The replacement is @trezor/transport, which speaks the same protobuf and
 * protocol this file's native session already uses, ships a `webusb` backend
 * for browsers, and depends on none of that. Wiring it is a separate piece of
 * work because it needs a physical device to verify; until then the browser
 * paths say so plainly rather than pretending.
 */

import { isDesktopPlatform } from '../../utils/platform';
import { TrezorNativeSession } from './TrezorNativeSession';

export interface TrezorPublicKey {
  xpub: string;
  path: string;
  label: string;
}

export interface TrezorSignResult {
  serializedTx: string;
}

export interface TrezorInput {
  address_n: number[];
  prev_hash: string;
  prev_index: number;
  amount: string;
  script_type: 'SPENDADDRESS';
}

export interface TrezorOutputExternal {
  address: string;
  amount: string;
  script_type: 'PAYTOADDRESS';
}

export interface TrezorOutputChange {
  address_n: number[];
  amount: string;
  script_type: 'PAYTOADDRESS';
}

export type TrezorOutput = TrezorOutputExternal | TrezorOutputChange;

const BCH_COIN_NAME = 'Bcash'; // protobuf coin_name for GetPublicKey / SignTx

/**
 * The browser has no Trezor transport yet.
 *
 * Thrown rather than returned so a caller cannot mistake it for a device that
 * answered. Says which surface, what is missing, and what still works, because
 * "Trezor failed" tells someone nothing they can act on.
 */
function browserNotWired(action: string): never {
  throw new Error(
    `Trezor ${action} is not available in the browser yet. The desktop app ` +
      'reaches the device over USB. Browser support is being rebuilt on ' +
      '@trezor/transport (WebUSB) after @trezor/connect-web was removed for ' +
      'carrying high-severity advisories through @stellar/stellar-sdk. ' +
      'Keystone over QR and watch-only both work here in the meantime.'
  );
}

export async function trezorGetPublicKey(
  derivationPath = "m/44'/145'/0'"
): Promise<TrezorPublicKey> {
  if (isDesktopPlatform()) {
    const session = new TrezorNativeSession('trezor');
    try {
      await session.open();
      const result = await session.getPublicKey(derivationPath, BCH_COIN_NAME);
      return {
        xpub: result.xpub,
        path: derivationPath,
        label: result.label || 'Trezor',
      };
    } finally {
      await session.close();
    }
  }

  return browserNotWired('account export');
}

export async function trezorGetAddress(
  path: string
): Promise<{ address: string }> {
  if (isDesktopPlatform()) {
    const session = new TrezorNativeSession('trezor');
    try {
      await session.open();
      await session.initialize();
      const res = await session.call('GetAddress', {
        address_n: pathToAddressN(path),
        coin_name: BCH_COIN_NAME,
        script_type: 'SPENDADDRESS',
        show_display: true,
      });
      const address = String(res.message.address ?? '');
      if (!address) throw new Error('Trezor: empty address');
      return { address };
    } finally {
      await session.close();
    }
  }

  return browserNotWired('address confirmation');
}

export async function trezorSignTransaction(
  inputs: TrezorInput[],
  outputs: TrezorOutput[]
): Promise<TrezorSignResult> {
  void inputs;
  void outputs;
  if (isDesktopPlatform()) {
    // Full SignTx multi-round (TxRequest) is large and not wired yet. This
    // used to tell people to sign in the browser instead, which stopped being
    // true when @trezor/connect-web was removed -- the browser path throws on
    // the next line. Naming a route that does not exist is worse than naming
    // none, so the message now offers only what actually works.
    throw new Error(
      'Trezor signing is not available yet: the desktop multi-round SignTx ' +
        'flow is still being written, and there is no browser transport since ' +
        '@trezor/connect-web was removed for security advisories. Connect and ' +
        'account export do work over native USB. To spend today, use a ' +
        'software wallet, or a watch-only wallet with an air-gapped signer.'
    );
  }

  return browserNotWired('signing');
}

export function pathToAddressN(path: string): number[] {
  return path
    .replace(/^m\//, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const hardened = segment.endsWith("'");
      const index = parseInt(hardened ? segment.slice(0, -1) : segment, 10);
      return hardened ? index + 0x80000000 : index;
    });
}
