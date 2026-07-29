import TrezorConnect from '@trezor/connect-web';

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

// External (recipient) output
export interface TrezorOutputExternal {
  address: string;
  amount: string;
  script_type: 'PAYTOADDRESS';
}

// Change output (wallet-owned)
export interface TrezorOutputChange {
  address_n: number[];
  amount: string;
  script_type: 'PAYTOADDRESS';
}

export type TrezorOutput = TrezorOutputExternal | TrezorOutputChange;

let initialized = false;

function ensureInitialized() {
  if (initialized) return;
  TrezorConnect.init({
    lazyLoad: true,
    manifest: {
      email: 'support@optnlabs.com',
      appUrl: 'https://optnlabs.com',
      appName: 'OPTN Wallet',
    },
  });
  initialized = true;
}

const BCH_COIN = 'Bch';

export async function trezorGetPublicKey(
  derivationPath = "m/44'/145'/0'"
): Promise<TrezorPublicKey> {
  ensureInitialized();
  const result = await TrezorConnect.getPublicKey({
    path: derivationPath,
    coin: BCH_COIN,
  });
  if (!result.success) {
    const errPayload = result.payload as { error: string };
    throw new Error(errPayload.error || 'Trezor: failed to get public key');
  }
  const label = (result as unknown as { payload: { device?: { label?: string } } })
    .payload?.device?.label ?? 'Trezor';
  return {
    xpub: result.payload.xpub,
    path: derivationPath,
    label,
  };
}

export async function trezorGetAddress(path: string): Promise<{ address: string }> {
  ensureInitialized();
  const result = await TrezorConnect.getAddress({
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
  ensureInitialized();
  // TrezorConnect's own types don't match this SDK version's actual accepted
  // shape for BCH inputs/outputs — casting through `any` here, not the
  // request object itself, so the disable comment sits on the exact lines it
  // suppresses (a misplaced disable previously suppressed nothing and left
  // these two casts flagged anyway).
  const result = await TrezorConnect.signTransaction({
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

// Convert a BIP44 path string like "m/44'/145'/0'/0/5" into Trezor's number array
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
