/**
 * Ledger hardware wallet service.
 *
 * Transports (TypeScript SDK on top):
 *   Desktop (Tauri) — native USB HID via Rust hidapi + LedgerTransportNative
 *                     (Electron Cash / Ledger Live model; WebView has no WebHID)
 *   Browser USB     — @ledgerhq/hw-transport-webhid
 *   Browser BLE     — @ledgerhq/hw-transport-web-ble (Nano X)
 *
 * App protocol: @ledgerhq/hw-app-btc with currency: 'bch'
 *   sigHashType 0x41 = SIGHASH_ALL | SIGHASH_FORKID
 */

import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import TransportWebBLE from '@ledgerhq/hw-transport-web-ble';
import Btc from '@ledgerhq/hw-app-btc';
import type Transport from '@ledgerhq/hw-transport';
import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeTransactionOutputs,
} from '@bitauth/libauth';
import { isDesktopPlatform } from '../../utils/platform';
import LedgerTransportNative from './LedgerTransportNative';

export type LedgerTransportType = 'usb' | 'ble';

export interface LedgerPublicKey {
  publicKey: string;
  chainCode: string;
  bitcoinAddress: string;
  path: string;
  label: string;
}

export interface LedgerSignResult {
  serializedTx: string;
}

export interface LedgerInput {
  /** BIP44 path WITHOUT leading "m/" e.g. "44'/145'/0'/0/5" */
  path: string;
  /** Full raw previous transaction hex (required by Ledger for fee validation) */
  prevTxHex: string;
  /** Outpoint txid (UI byte order / Electrum), needed for Trezor prev_tx map */
  prevHash?: string;
  prevIndex: number;
  sequence?: number;
  /** Satoshi value of the UTXO (Trezor TxInputType.amount; EC passes txin value) */
  amountSatoshis?: bigint;
}

export interface LedgerOutput {
  address: string;
  amountSatoshis: bigint;
}

let transport: Transport | null = null;
let currentTransportType: LedgerTransportType = 'usb';

/** Official hw-app-btc flag for Bitcoin Cash (enables BIP143 / FORKID path). */
const BCH_ADDITIONALS = ['abc'] as const;

export function setLedgerTransportType(type: LedgerTransportType): void {
  if (type !== currentTransportType) {
    transport = null;
    currentTransportType = type;
  }
}

export function getLedgerTransportType(): LedgerTransportType {
  return currentTransportType;
}

/**
 * Open (or reuse) a Ledger transport. Prefer one long-lived session per sign
 * (Windows HID invalidates handles if we open → close → reopen quickly).
 */
export async function getTransport(): Promise<Transport> {
  if (transport) {
    return transport;
  }

  // Desktop app: always native USB for "usb" (WebHID is missing in WebView2).
  if (currentTransportType === 'usb' && isDesktopPlatform()) {
    transport = await LedgerTransportNative.open();
  } else if (currentTransportType === 'ble') {
    if (isDesktopPlatform()) {
      throw new Error(
        'Ledger Bluetooth is not available in the desktop app yet. Use USB.'
      );
    }
    transport = await TransportWebBLE.create();
  } else {
    transport = await TransportWebHID.create();
  }

  transport.on('disconnect', () => {
    transport = null;
  });
  return transport;
}

/** Drop cached transport so the next call re-opens HID (after 0x48F / unplug). */
export async function invalidateLedgerTransport(): Promise<void> {
  if (transport) {
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
    transport = null;
  }
}

function createBchApp(t: Transport): Btc {
  // currency 'bch' → BtcOld (legacy Bitcoin Cash app APDUs), not app-bitcoin-new
  return new Btc({ transport: t as never, currency: 'bch' });
}

function isHidGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /0x0000048F|not connected|invalid or closed hardware session|HID write failed|device path not found/i.test(
      msg
    )
  );
}

/**
 * Get the public key and address for a derivation path.
 * @param derivationPath BIP44 path without "m/" prefix, e.g. "44'/145'/0'"
 * @param verify If true, show address on device for user confirmation
 */
export async function ledgerGetPublicKey(
  derivationPath = "44'/145'/0'",
  verify = false
): Promise<LedgerPublicKey> {
  const t = await getTransport();
  const bch = createBchApp(t);
  const result = await bch.getWalletPublicKey(derivationPath, {
    verify,
    format: 'cashaddr',
  });
  return {
    publicKey: result.publicKey,
    chainCode: result.chainCode,
    bitcoinAddress: result.bitcoinAddress,
    path: derivationPath,
    label: 'Ledger',
  };
}

export async function ledgerGetAddress(
  path: string,
  verify = true
): Promise<{ address: string }> {
  const t = await getTransport();
  const bch = createBchApp(t);
  const result = await bch.getWalletPublicKey(path, {
    verify,
    format: 'cashaddr',
  });
  return { address: result.bitcoinAddress };
}

/**
 * Sign a BCH transaction with the Ledger device.
 *
 * Ledger requires the full raw previous transaction for each input —
 * this prevents a class of "fee inflation" attacks where a malicious app
 * could lie about UTXO values and drain more than the user approved.
 *
 * @param existingTransport optional open transport (keep one HID session for
 *   assert-app + sign; Windows 0x48F if we close/reopen between them).
 */
export type LedgerSignHooks = {
  onDeviceSignatureRequested?: () => void;
  onDeviceSignatureGranted?: () => void;
};

export async function ledgerSignTransaction(
  inputs: LedgerInput[],
  outputs: LedgerOutput[],
  changePath?: string,
  existingTransport?: Transport,
  hooks?: LedgerSignHooks
): Promise<LedgerSignResult> {
  const run = async (t: Transport): Promise<string> => {
    const bch = createBchApp(t);

    // split with BCH additionals so prev_tx parse matches createPaymentTransaction
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const splitInputs: any[] = inputs.map((inp) => {
      const splitTx = bch.splitTransaction(
        inp.prevTxHex,
        false,
        false,
        [...BCH_ADDITIONALS]
      );
      return [splitTx, inp.prevIndex, undefined, inp.sequence ?? 0xffffffff];
    });

    const associatedKeysets = inputs.map((inp) =>
      inp.path.replace(/^m\//i, '')
    );
    const outputScriptHex = buildOutputScript(outputs);
    const change =
      changePath != null && changePath.length > 0
        ? changePath.replace(/^m\//i, '')
        : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const btcAny = bch as any;
    const signerMethod: string =
      typeof btcAny.createPaymentTransactionNew === 'function'
        ? 'createPaymentTransactionNew'
        : 'createPaymentTransaction';

    // hw-app-btc docs: "abc" for bch; sigHashType 0x41 = ALL|FORKID (EC ledger.py)
    // During "finalization" the device shows outputs — user MUST press buttons.
    return btcAny[signerMethod]({
      inputs: splitInputs,
      associatedKeysets,
      outputScriptHex,
      changePath: change,
      sigHashType: 0x41,
      segwit: false,
      additionals: [...BCH_ADDITIONALS],
      // Prefer software BIP143 trusted inputs for BCH when possible — avoids
      // device getTrustedInput "missing result in processScriptBlocks" on some
      // prev txs; Live still uses device trusted inputs when this is true.
      useTrustedInputForSegwit: false,
      onDeviceSignatureRequested: () => {
        hooks?.onDeviceSignatureRequested?.();
      },
      onDeviceSignatureGranted: () => {
        hooks?.onDeviceSignatureGranted?.();
      },
    });
  };

  let t = existingTransport ?? (await getTransport());
  try {
    const signedHex = await run(t);
    return { serializedTx: signedHex };
  } catch (err) {
    if (!isHidGoneError(err)) throw err;
    // Stale HID handle (common after app switch / double-open on Windows).
    await invalidateLedgerTransport();
    t = await getTransport();
    try {
      const signedHex = await run(t);
      return { serializedTx: signedHex };
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      throw new Error(
        `${msg}\n\nLedger USB dropped (device not connected). ` +
          `Unlock the Nano, open the Bitcoin Cash app, unplug/replug if needed, then try Send again. ` +
          `Close Ledger Live if it is using the device.`
      );
    }
  }
}

/**
 * Ledger hw-app-btc docs: outputScriptHex is the hex serialization of outputs
 * **including leading compact-size voutCount** (EC: var_int(len(outputs)) + …).
 * Built with libauth encodeTransactionOutputs — same wire format as BCH txs.
 */
function buildOutputScript(outputs: LedgerOutput[]): string {
  const libauthOutputs = outputs.map((out) => {
    const decoded = cashAddressToLockingBytecode(out.address);
    if (typeof decoded === 'string') {
      throw new Error(`Ledger: invalid recipient address: ${decoded}`);
    }
    return {
      lockingBytecode: decoded.bytecode,
      valueSatoshis: out.amountSatoshis,
    };
  });
  return binToHex(encodeTransactionOutputs(libauthOutputs));
}

export async function ledgerDisconnect(): Promise<void> {
  await invalidateLedgerTransport();
}
