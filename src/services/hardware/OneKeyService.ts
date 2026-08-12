/**
 * OneKey hardware wallet service using the official OneKey Hardware JS SDK.
 *
 * OneKey devices are protocol-compatible with Trezor but use their own
 * bridge and SDK. The @onekeyfe/hd-web-sdk package provides the web/desktop API.
 *
 * SDK reference: https://developer.onekey.so/en/
 * GitHub: https://github.com/OneKeyHQ/hardware-js-sdk
 */

// @onekeyfe/hd-web-sdk is a browser bundle — only works in webview context
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sdk: any = null;

async function getSDK() {
  if (sdk) return sdk;
  // Dynamic import ensures this only loads in browser/webview context
  const mod = await import('@onekeyfe/hd-web-sdk');
  sdk = mod.default ?? mod;
  return sdk;
}

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

let initialized = false;

async function ensureInitialized() {
  if (initialized) return;
  const HW = await getSDK();
  await HW.init({
    debug: false,
    // connectSrc is the OneKey Bridge URL — defaults to the official bridge
    // For desktop use, OneKey Bridge daemon must be installed (similar to Trezor Bridge)
  });
  initialized = true;
}

// OneKey SDK coin identifier for Bitcoin Cash (confirmed from SDK bundle)
const BCH_COIN = 'BCH';

export async function oneKeyGetPublicKey(
  derivationPath = "m/44'/145'/0'"
): Promise<OneKeyPublicKey> {
  await ensureInitialized();
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

export async function oneKeyGetAddress(path: string): Promise<{ address: string }> {
  await ensureInitialized();
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
  await ensureInitialized();
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

// Convert BIP44 path string to number array (same as Trezor format)
export function pathToAddressN(path: string): number[] {
  return path
    .replace(/^m\//, '')
    .split('/')
    .map((segment) => {
      const hardened = segment.endsWith("'");
      const index = parseInt(hardened ? segment.slice(0, -1) : segment, 10);
      return hardened ? index + 0x80000000 : index;
    });
}
