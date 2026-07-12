/**
 * Ledger hardware wallet service using the official Ledger SDK.
 *
 * Transports:
 *   USB  — @ledgerhq/hw-transport-webhid (Web HID, official for browsers/Tauri)
 *   BLE  — @ledgerhq/hw-transport-web-ble (Web Bluetooth, for Ledger Nano X)
 *
 * Both transports require the Bitcoin Cash app open on the Ledger device.
 *
 * Signing: @ledgerhq/hw-app-btc
 *   - Handles P2PKH signing for BCH (Bitcoin Cash) using currency: 'bch'
 *   - sigHashType: 0x41 = SIGHASH_ALL | SIGHASH_FORKID (BCH replay protection)
 *   - Requires fetching full previous raw transactions (Ledger validates fees)
 */

import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import TransportWebBLE from '@ledgerhq/hw-transport-web-ble';
import Btc from '@ledgerhq/hw-app-btc';
import type Transport from '@ledgerhq/hw-transport';
import { cashAddressToLockingBytecode } from '@bitauth/libauth';

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
  prevIndex: number;
  sequence?: number;
}

export interface LedgerOutput {
  address: string;
  amountSatoshis: bigint;
}

let transport: Transport | null = null;
let currentTransportType: LedgerTransportType = 'usb';

export function setLedgerTransportType(type: LedgerTransportType): void {
  if (type !== currentTransportType) {
    // Force reconnect when transport type changes
    transport = null;
    currentTransportType = type;
  }
}

export function getLedgerTransportType(): LedgerTransportType {
  return currentTransportType;
}

async function getTransport(): Promise<Transport> {
  if (transport) {
    return transport;
  }
  if (currentTransportType === 'ble') {
    transport = await TransportWebBLE.create();
  } else {
    transport = await TransportWebHID.create();
  }
  transport.on('disconnect', () => {
    transport = null;
  });
  return transport;
}

function createBchApp(t: Transport): Btc {
  // currency: 'bch' tells hw-app-btc to use Bitcoin Cash parameters
  return new Btc({ transport: t as never, currency: 'bch' });
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
 */
export async function ledgerSignTransaction(
  inputs: LedgerInput[],
  outputs: LedgerOutput[],
  changePath?: string
): Promise<LedgerSignResult> {
  const t = await getTransport();
  const bch = createBchApp(t);

  // Ledger requires splitting each previous transaction
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const splitInputs: any[] = inputs.map((inp) => {
    const splitTx = bch.splitTransaction(inp.prevTxHex, false);
    return [splitTx, inp.prevIndex, undefined, inp.sequence ?? 0xffffffff];
  });

  const associatedKeysets = inputs.map((inp) => inp.path);
  const outputScriptHex = buildOutputScript(outputs);

  // hw-app-btc uses createPaymentTransaction (v10+) or createPaymentTransactionNew (v9)
  // We try the newer API name first and fall back gracefully.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const btcAny = bch as any;
  const signerMethod: string =
    typeof btcAny.createPaymentTransactionNew === 'function'
      ? 'createPaymentTransactionNew'
      : 'createPaymentTransaction';

  const signedHex: string = await btcAny[signerMethod]({
    inputs: splitInputs,
    associatedKeysets,
    outputScriptHex,
    changePath,
    // SIGHASH_ALL | SIGHASH_FORKID (0x41) — mandatory for BCH replay protection
    sigHashType: 0x41,
    segwit: false,
    additionals: ['bch'],
  });

  return { serializedTx: signedHex };
}

/**
 * Build Ledger's output script hex format.
 * Each output: 8-byte LE amount + varint length + scriptPubKey bytes.
 *
 * Decodes each address via @bitauth/libauth's cashAddressToLockingBytecode
 * (already a project dependency, already used for the reverse direction in
 * hardwareWalletSigning.ts) instead of a hand-rolled bech32 decode — the
 * previous version stripped the last 8 groups and assumed they were a valid
 * checksum without ever actually verifying it against the computed polymod.
 */
function buildOutputScript(outputs: LedgerOutput[]): string {
  let result = '';
  for (const out of outputs) {
    const amtBuf = new ArrayBuffer(8);
    const view = new DataView(amtBuf);
    const lo = Number(out.amountSatoshis & 0xffffffffn);
    const hi = Number((out.amountSatoshis >> 32n) & 0xffffffffn);
    view.setUint32(0, lo, true);
    view.setUint32(4, hi, true);
    result += bufToHex(new Uint8Array(amtBuf));

    const decoded = cashAddressToLockingBytecode(out.address);
    if (typeof decoded === 'string') {
      throw new Error(`Ledger: invalid recipient address: ${decoded}`);
    }
    const script = bufToHex(decoded.bytecode);
    result += (script.length / 2).toString(16).padStart(2, '0');
    result += script;
  }
  return result;
}

function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function ledgerDisconnect(): Promise<void> {
  if (transport) {
    await transport.close();
    transport = null;
  }
}
