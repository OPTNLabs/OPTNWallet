/**
 * OneKey hardware wallet service.
 *
 * OneKey Pro / classic devices speak a Trezor-compatible protobuf stack.
 * Desktop: same native USB HID path as Trezor (TypeScript protobuf + hidapi).
 * Browser: @onekeyfe/hd-web-sdk (bridge / web).
 */

import { isDesktopPlatform } from '../../utils/platform';
import { TrezorNativeSession } from './TrezorNativeSession';

export interface OneKeyPublicKey {
  xpub: string;
  path: string;
  label: string;
}

export interface OneKeySignResult {
  serializedTx: string;
}

export interface OneKeyInput {
  address_n: number[];
  prev_hash: string;
  prev_index: number;
  amount: string;
  script_type: 'SPENDADDRESS';
}

export interface OneKeyOutput {
  address: string;
  amount: string;
  script_type: 'PAYTOADDRESS';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sdk: any = null;
let webInitialized = false;

const BCH_COIN = 'BCH';
const BCH_COIN_NAME = 'Bcash';

async function getSDK() {
  if (sdk) return sdk;
  const mod = await import('@onekeyfe/hd-web-sdk');
  sdk = mod.default ?? mod;
  return sdk;
}

async function ensureWebInitialized() {
  if (webInitialized) return;
  const HW = await getSDK();
  await HW.init({ debug: false });
  webInitialized = true;
}

export async function oneKeyGetPublicKey(
  derivationPath = "m/44'/145'/0'"
): Promise<OneKeyPublicKey> {
  if (isDesktopPlatform()) {
    const session = new TrezorNativeSession('onekey');
    try {
      await session.open();
      const result = await session.getPublicKey(derivationPath, BCH_COIN_NAME);
      return {
        xpub: result.xpub,
        path: derivationPath,
        label: result.label || 'OneKey',
      };
    } finally {
      await session.close();
    }
  }

  await ensureWebInitialized();
  const HW = await getSDK();
  const result = await HW.btcGetPublicKey({
    path: derivationPath,
    coin: BCH_COIN,
    showOnOneKey: false,
  });
  if (!result.success) {
    throw new Error(result.payload?.error ?? 'OneKey: failed to get public key');
  }
  return {
    xpub: result.payload.xpub,
    path: derivationPath,
    label: result.payload.device?.label ?? 'OneKey',
  };
}

export async function oneKeyGetAddress(
  path: string
): Promise<{ address: string }> {
  if (isDesktopPlatform()) {
    const session = new TrezorNativeSession('onekey');
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
      if (!address) throw new Error('OneKey: empty address');
      return { address };
    } finally {
      await session.close();
    }
  }

  await ensureWebInitialized();
  const HW = await getSDK();
  const result = await HW.btcGetAddress({
    path,
    coin: BCH_COIN,
    showOnOneKey: true,
  });
  if (!result.success) {
    throw new Error(result.payload?.error ?? 'OneKey: failed to get address');
  }
  return { address: result.payload.address };
}

export async function oneKeySignTransaction(
  inputs: OneKeyInput[],
  outputs: OneKeyOutput[]
): Promise<OneKeySignResult> {
  if (isDesktopPlatform()) {
    throw new Error(
      'Desktop native OneKey signing (SignTx multi-round) is next. ' +
        'Connect and xpub already use native USB (Trezor-compatible stack).'
    );
  }

  await ensureWebInitialized();
  const HW = await getSDK();
  const result = await HW.btcSignTransaction({
    inputs,
    outputs,
    coin: BCH_COIN,
  });
  if (!result.success) {
    throw new Error(result.payload?.error ?? 'OneKey: signing failed');
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
