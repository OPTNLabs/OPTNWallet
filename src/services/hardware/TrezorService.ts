/**
 * Trezor service.
 *
 * Desktop (Tauri): native USB HID + @trezor/protobuf (Suite / Electron Cash model).
 * Browser:         @trezor/connect-web (iframe + Bridge/WebUSB).
 */

import type TrezorConnectType from '@trezor/connect-web';
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

const BCH_COIN = 'Bch';
const BCH_COIN_NAME = 'Bcash'; // protobuf coin_name for GetPublicKey / SignTx

let webInitialized = false;
let TrezorConnect: typeof TrezorConnectType | null = null;

async function getWebConnect(): Promise<typeof TrezorConnectType> {
  if (!TrezorConnect) {
    const mod = await import('@trezor/connect-web');
    TrezorConnect = mod.default;
  }
  if (!webInitialized) {
    await TrezorConnect.init({
      lazyLoad: true,
      manifest: {
        email: 'support@optnlabs.com',
        appUrl: 'https://optnlabs.com',
        appName: 'OPTN Wallet',
      },
    });
    webInitialized = true;
  }
  return TrezorConnect;
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

  const connect = await getWebConnect();
  const result = await connect.getPublicKey({
    path: derivationPath,
    coin: BCH_COIN,
  });
  if (!result.success) {
    const errPayload = result.payload as { error: string };
    throw new Error(errPayload.error || 'Trezor: failed to get public key');
  }
  const label =
    (result as unknown as { payload: { device?: { label?: string } } }).payload
      ?.device?.label ?? 'Trezor';
  return {
    xpub: result.payload.xpub,
    path: derivationPath,
    label,
  };
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

  const connect = await getWebConnect();
  const result = await connect.getAddress({
    path,
    coin: BCH_COIN,
    showOnTrezor: true,
  });
  if (!result.success) {
    const errPayload = result.payload as { error: string };
    throw new Error(errPayload.error || 'Trezor: failed to get address');
  }
  return { address: result.payload.address };
}

export async function trezorSignTransaction(
  inputs: TrezorInput[],
  outputs: TrezorOutput[]
): Promise<TrezorSignResult> {
  if (isDesktopPlatform()) {
    // Full SignTx multi-round (TxRequest) is large; keep Connect-web parity via
    // a clear error until the interactive SignTx loop is wired. Connect path
    // remains for browser. Desktop users can still load xpub / verify address.
    throw new Error(
      'Desktop native Trezor signing (SignTx multi-round) is next. ' +
        'Connect and xpub already use native USB. Use the browser build for signing until then, or continue with software/watch-only.'
    );
  }

  const connect = await getWebConnect();
  const result = await connect.signTransaction({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputs: inputs as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputs: outputs as any,
    coin: BCH_COIN,
  });
  if (!result.success) {
    const errPayload = result.payload as { error: string };
    throw new Error(errPayload.error || 'Trezor: signing failed');
  }
  return { serializedTx: result.payload.serializedTx };
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
