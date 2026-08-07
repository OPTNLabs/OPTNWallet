/**
 * Hardware wallet signing — mirrors Electron Cash, not inventing a new model.
 *
 * Electron Cash (wallet.py):
 *   sign_transaction(tx, password):
 *     1. add_input_values_to_tx  — attach prev_tx + value for each input
 *     2. add_hw_info             — prev_tx for HW + change output_info
 *     3. for k in keystores: k.sign_transaction(tx, password)
 *
 * Ledger plugin (ledger.py + btchip / Live hw-app-btc):
 *   - needs full previous raw txs (needs_prevtx = True)
 *   - signs with SIGHASH_ALL|FORKID (0x41)
 *   - createPaymentTransaction / startUntrustedTransaction + untrustedHashSign
 *
 * Trezor plugin (trezor.py + trezorlib):
 *   - needs prev_tx map
 *   - client.sign_tx(coin, inputs, outputs, prev_txes=…)
 *
 * OPTN maps that onto:
 *   ElectrumService (prev raw txs) + LedgerService.ledgerSignTransaction
 *   (official @ledgerhq/hw-app-btc) + Trezor Bridge/protobuf for Safe devices.
 */

import type { TransactionOutput, UTXO } from '../../types/types';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import {
  type LedgerInput,
  type LedgerOutput,
  setLedgerTransportType,
} from './LedgerService';
import { ledgerAssertBitcoinCashApp } from './ledgerXpub';
import { readHardwareKeystore } from '../../platform/desktop/onboarding/hardwareWallet';
import { trezorSignPayment } from './trezorSignPayment';

export type HardwareSignPlan = {
  walletId: number;
  deviceKind: 'ledger' | 'trezor' | 'onekey';
  /** Account derivation e.g. m/44'/145'/0' */
  accountPath: string;
  inputs: UTXO[];
  outputs: Array<{ address: string; amountSatoshis: bigint }>;
  /** BIP44 change path without m/ if change is ours, else undefined */
  changePath?: string;
};

function utxoSats(u: UTXO): bigint {
  const raw = u.value ?? u.amount ?? 0;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') return BigInt(Math.trunc(raw));
  try {
    return BigInt(String(raw));
  } catch {
    return 0n;
  }
}

/**
 * EC wallet.add_input_values_to_tx / get_input_tx:
 * fetch full previous raw transactions required by hardware devices.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `${label} timed out after ${Math.round(ms / 1000)}s. Check Electrum connection / device.`
          )
        ),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** EC wallet.get_input_tx → full previous raw transaction hex. */
async function fetchPrevTxHex(txid: string): Promise<string> {
  // Electrum protocol: blockchain.transaction.get(txid, false) returns hex.
  const server = (
    await import('../../apis/ElectrumServer/ElectrumServer')
  ).default();
  const hex = await withTimeout(
    server.request('blockchain.transaction.get', txid, false),
    20_000,
    `Loading prev_tx ${txid.slice(0, 12)}…`
  );
  if (typeof hex !== 'string' || hex.length < 20) {
    throw new Error(
      `Could not load previous transaction ${txid} for hardware signing (EC needs prev_tx).`
    );
  }
  return hex;
}

/** Ledger/EC paths: no leading "m/". */
function stripM(path: string): string {
  return path.replace(/^m\//i, '').replace(/^\//, '');
}

/**
 * Map UTXO address → HD path suffix from keys table (change_index/address_index),
 * same idea as EC get_address_index + keystore derivation.
 */
async function pathForAddress(
  walletId: number,
  accountPath: string,
  address: string
): Promise<string> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Database unavailable');

  const q = db.prepare(
    `SELECT change_index, address_index FROM keys
     WHERE wallet_id = ? AND (address = ? OR token_address = ?)
     LIMIT 1`
  );
  try {
    q.bind([walletId, address, address]);
    if (!q.step()) {
      throw new Error(
        `No key path for address ${address} (is this a hardware wallet address?).`
      );
    }
    const row = q.getAsObject() as {
      change_index?: number;
      address_index?: number;
    };
    const change = Number(row.change_index ?? 0);
    const index = Number(row.address_index ?? 0);
    const base = stripM(accountPath).replace(/\/$/, '');
    // Ledger/EC paths omit leading m/
    return stripM(`${base}/${change}/${index}`);
  } finally {
    q.free();
  }
}

/**
 * EC: wallet.get_keystore() → Hardware_KeyStore with hw_type + derivation.
 * Device plugin (Ledger/Trezor) signs — not watch-only fingerprint metadata.
 */
async function readHardwareMeta(walletId: number): Promise<{
  accountPath: string;
  deviceKind: 'ledger' | 'trezor' | 'onekey';
  network: 'mainnet' | 'chipnet';
}> {
  const ks = await readHardwareKeystore(walletId);
  return {
    accountPath: ks.accountPath,
    deviceKind: ks.hwType,
    network: ks.network,
  };
}

/**
 * Sign a simple P2PKH payment with the hardware device.
 * Follows EC: prev_tx fetch → device sign → full signed hex.
 */
export type HardwareSignProgress =
  | 'loading-prev-txs'
  | 'opening-device'
  | 'assert-app'
  | 'confirm-on-device'
  | 'signing'
  | 'done';

export async function signHardwarePayment(args: {
  walletId: number;
  inputs: UTXO[];
  /** Final outputs including change (amounts in sats). */
  outputs: TransactionOutput[];
  changeAddress?: string;
  onProgress?: (stage: HardwareSignProgress, detail?: string) => void;
}): Promise<string> {
  const progress = args.onProgress ?? (() => undefined);
  const meta = await readHardwareMeta(args.walletId);
  if (!args.inputs.length) throw new Error('No inputs to sign.');
  if (!args.outputs.length) throw new Error('No outputs to sign.');

  const ledgerOutputs: LedgerOutput[] = [];
  for (const o of args.outputs) {
    if ('opReturn' in o && o.opReturn !== undefined) {
      throw new Error(
        'OP_RETURN outputs are not supported on this hardware send path yet (EC Ledger supports limited script outputs).'
      );
    }
    if (o.token) {
      throw new Error(
        'CashTokens with hardware wallets are not supported yet (EC also warns on tokens for most HW).'
      );
    }
    const amount =
      typeof o.amount === 'bigint'
        ? o.amount
        : BigInt(Math.trunc(Number(o.amount ?? 0)));
    ledgerOutputs.push({
      address: o.recipientAddress,
      amountSatoshis: amount,
    });
  }

  // EC add_input_values_to_tx / add_hw_info: load prev_tx for every input (parallel).
  progress(
    'loading-prev-txs',
    `Fetching ${args.inputs.length} previous transaction(s)…`
  );
  const uniqueTxids = [...new Set(args.inputs.map((u) => u.tx_hash))];
  const prevHexByTxid = new Map<string, string>();
  await Promise.all(
    uniqueTxids.map(async (txid) => {
      prevHexByTxid.set(txid, await fetchPrevTxHex(txid));
    })
  );

  const ledgerInputs: Array<
    LedgerInput & { prevHash: string; amountSatoshis: bigint }
  > = [];
  for (const u of args.inputs) {
    const prevTxHex = prevHexByTxid.get(u.tx_hash);
    if (!prevTxHex) {
      throw new Error(`Missing prev_tx for ${u.tx_hash}`);
    }
    const path = await pathForAddress(
      args.walletId,
      meta.accountPath,
      u.address
    );
    ledgerInputs.push({
      path: stripM(path),
      prevTxHex,
      prevHash: u.tx_hash,
      prevIndex: u.tx_pos,
      sequence: 0xffffffff,
      // EC txin['value'] — required by Trezor SPENDADDRESS
      amountSatoshis: utxoSats(u),
    });
  }

  let changePath: string | undefined;
  /** Index of change in `ledgerOutputs`, or undefined if none / not found. */
  let changeOutputIndex: number | undefined;
  if (args.changeAddress) {
    try {
      changePath = stripM(
        await pathForAddress(
          args.walletId,
          meta.accountPath,
          args.changeAddress
        )
      );
      const idx = args.outputs.findIndex(
        (o) => o.recipientAddress === args.changeAddress
      );
      if (idx >= 0) {
        changeOutputIndex = idx;
      } else {
        // Address not in the planned outputs — do not mark any output as change.
        changePath = undefined;
      }
    } catch {
      changePath = undefined;
      changeOutputIndex = undefined;
    }
  }

  if (meta.deviceKind === 'ledger') {
    setLedgerTransportType('usb');
    // ONE HID session for assert + sign (EC/Live keep the dongle open).
    // Open → close → reopen on Windows often yields 0x48F "device not connected".
    const {
      getTransport,
      invalidateLedgerTransport,
      ledgerSignTransaction: signOnLedger,
    } = await import('./LedgerService');
    progress('opening-device', 'Opening Ledger USB…');
    await invalidateLedgerTransport(); // drop any stale cached handle
    const transport = await getTransport();
    try {
      progress('assert-app', 'Checking Bitcoin Cash app…');
      await ledgerAssertBitcoinCashApp(transport);
      progress(
        'confirm-on-device',
        'Confirm amount and address on the Ledger — look at the device screen'
      );
      const signed = await withTimeout(
        signOnLedger(ledgerInputs, ledgerOutputs, changePath, transport, {
          onDeviceSignatureRequested: () =>
            progress(
              'confirm-on-device',
              'Approve the transaction on your Ledger (buttons)'
            ),
          onDeviceSignatureGranted: () =>
            progress('signing', 'Signing on device…'),
        }),
        // Device confirmation can take a while; HID read allows 120s per APDU.
        180_000,
        'Ledger transaction finalization'
      );
      progress('done');
      return signed.serializedTx;
    } finally {
      // Release USB so Ledger Live / next session can claim the device.
      await invalidateLedgerTransport();
    }
  }

  if (meta.deviceKind === 'trezor' || meta.deviceKind === 'onekey') {
    return trezorSignPayment({
      accountPath: meta.accountPath,
      inputs: ledgerInputs,
      outputs: ledgerOutputs,
      changePath,
      changeOutputIndex,
      deviceKind: meta.deviceKind,
      // EC get_coin_name(): Bcash vs Bcash Testnet
      network: meta.network,
    });
  }

  throw new Error(`Unsupported hardware device: ${meta.deviceKind}`);
}

/** Rough P2PKH size estimate used when software keys are absent (EC fee planning). */
export function estimateP2pkhTxBytes(
  inputCount: number,
  outputCount: number
): number {
  // Classic non-segwit P2PKH approximation used by many SPV wallets.
  return 10 + inputCount * 148 + outputCount * 34;
}

export function feeForBytes(bytes: number, satPerByte = 1.1): number {
  return Math.ceil(bytes * satPerByte);
}

export function sumUtxoSats(utxos: UTXO[]): bigint {
  return utxos.reduce((s, u) => s + utxoSats(u), 0n);
}
