/**
 * Bridges WizardConnect SignTransactionRequest to hardware device signing calls.
 * Supports: Trezor (native USB HID; browser pending @trezor/transport),
 *           Ledger (webhid + hw-app-btc), OneKey (hd-web-sdk),
 *           Keystone (air-gap QR via SDK).
 * Private keys never enter the app — the device is the signing authority.
 */

import {
  binToHex,
  decodeTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';
import type { Input, Output } from '@bitauth/libauth';
import type { ContractInfo } from '../../types/wcInterfaces';
import { ensureUint8Array } from '../../utils/binary';
import { PREFIX } from '../../utils/constants';
import { Network } from '../../state/slices/networkSlice';
import { getBchAddressPath, BCH_STANDARD_BRANCH_INDEX } from '../HdWalletService';
import {
  trezorSignTransaction,
  pathToAddressN,
  type TrezorInput,
  type TrezorOutputExternal,
} from './TrezorService';
import {
  ledgerSignTransaction,
  type LedgerInput,
  type LedgerOutput,
} from './LedgerService';
import {
  oneKeySignTransaction,
  pathToAddressN as oneKeyPathToAddressN,
  type OneKeyInput,
  type OneKeyOutput,
} from './OneKeyService';

type PathName = 'receive' | 'change' | 'defi';

// Sourced directly from BCH_STANDARD_BRANCH_INDEX (HdWalletService.ts) so this
// can never drift from the canonical branch indices again — it previously
// hardcoded 'defi' as branch 2 when the actual value is 7, which would have
// derived the wrong signing key for any hardware-wallet request touching a
// 'defi'-branch UTXO. `network` also selects the BIP44 coin type: 145 for BCH
// mainnet and 1 for Chipnet/testnet.
export function buildBip44Path(
  network: Network,
  pathName: PathName,
  addressIndex: number,
  accountPath?: string
): string {
  return getBchAddressPath(
    network,
    0,
    BCH_STANDARD_BRANCH_INDEX[pathName],
    addressIndex,
    accountPath
  );
}

// Extract TXID in display (reversed) order from libauth's internal bytes
function txidHex(hash: Uint8Array): string {
  return binToHex(Uint8Array.from(hash).reverse());
}

export async function signWithTrezor(
  request: SignTransactionRequest,
  network: Network,
  accountPath?: string
): Promise<string> {
  const payload = request.transaction;
  const txDetails =
    typeof payload.transaction === 'string'
      ? decodeTransaction(hexToBin(payload.transaction))
      : payload.transaction;

  if (!txDetails || typeof txDetails === 'string') {
    throw new Error('Hardware wallet: invalid transaction payload');
  }

  const sourceOutputs = payload.sourceOutputs as (Input & Output & ContractInfo)[];
  const inputPaths = new Map(
    request.inputPaths.map(([index, path, addressIndex]) => [
      index,
      { path: path as PathName, addressIndex },
    ])
  );
  const networkPrefix = PREFIX[network];

  const trezorInputs: TrezorInput[] = txDetails.inputs.map((input, i) => {
    const pathInfo = inputPaths.get(i);
    const bip44 = pathInfo
      ? buildBip44Path(network, pathInfo.path, pathInfo.addressIndex, accountPath)
      : buildBip44Path(network, 'receive', 0, accountPath);
    return {
      address_n: pathToAddressN(bip44),
      prev_hash: txidHex(ensureUint8Array(input.outpointTransactionHash)),
      prev_index: input.outpointIndex,
      amount: String(sourceOutputs[i]?.valueSatoshis ?? 0n),
      script_type: 'SPENDADDRESS',
    };
  });

  // All outputs are treated as external (recipient) since WizardConnect
  // doesn't expose which output index is change via inputPaths
  const trezorOutputs: TrezorOutputExternal[] = txDetails.outputs.map((output) => {
    const lcb = ensureUint8Array(output.lockingBytecode);
    const addressResult = lockingBytecodeToCashAddress({ prefix: networkPrefix, bytecode: lcb });
    const address = typeof addressResult === 'string' ? addressResult : String(addressResult);
    return { address, amount: String(output.valueSatoshis), script_type: 'PAYTOADDRESS' };
  });

  const result = await trezorSignTransaction(trezorInputs, trezorOutputs);
  return result.serializedTx;
}

export async function signWithLedger(
  request: SignTransactionRequest,
  network: Network,
  fetchRawTx: (txid: string) => Promise<string>,
  accountPath?: string
): Promise<string> {
  const payload = request.transaction;
  const txDetails =
    typeof payload.transaction === 'string'
      ? decodeTransaction(hexToBin(payload.transaction))
      : payload.transaction;

  if (!txDetails || typeof txDetails === 'string') {
    throw new Error('Hardware wallet: invalid transaction payload');
  }

  const inputPaths = new Map(
    request.inputPaths.map(([index, path, addressIndex]) => [
      index,
      { path: path as PathName, addressIndex },
    ])
  );
  const networkPrefix = PREFIX[network];

  const ledgerInputs: LedgerInput[] = await Promise.all(
    txDetails.inputs.map(async (input, i) => {
      const pathInfo = inputPaths.get(i);
      const bip44 = pathInfo
        ? buildBip44Path(network, pathInfo.path, pathInfo.addressIndex, accountPath)
        : buildBip44Path(network, 'receive', 0, accountPath);
      const txid = txidHex(ensureUint8Array(input.outpointTransactionHash));
      const prevTxHex = await fetchRawTx(txid);
      return {
        path: bip44.replace(/^m\//, ''),
        prevTxHex,
        prevIndex: input.outpointIndex,
      };
    })
  );

  const ledgerOutputs: LedgerOutput[] = txDetails.outputs.map((output) => {
    const lcb = ensureUint8Array(output.lockingBytecode);
    const addressResult = lockingBytecodeToCashAddress({ prefix: networkPrefix, bytecode: lcb });
    return {
      address: typeof addressResult === 'string' ? addressResult : String(addressResult),
      amountSatoshis: output.valueSatoshis,
    };
  });

  const result = await ledgerSignTransaction(ledgerInputs, ledgerOutputs);
  return result.serializedTx;
}

/**
 * OneKey signing — same structure as Trezor since they share the same
 * Protobuf-based protocol. OneKey uses 'BCH' as the coin identifier.
 */
export async function signWithOneKey(
  request: SignTransactionRequest,
  network: Network,
  accountPath?: string
): Promise<string> {
  const payload = request.transaction;
  const txDetails =
    typeof payload.transaction === 'string'
      ? decodeTransaction(hexToBin(payload.transaction))
      : payload.transaction;

  if (!txDetails || typeof txDetails === 'string') {
    throw new Error('Hardware wallet: invalid transaction payload');
  }

  const sourceOutputs = payload.sourceOutputs as (Input & Output & ContractInfo)[];
  const inputPaths = new Map(
    request.inputPaths.map(([index, path, addressIndex]) => [
      index,
      { path: path as PathName, addressIndex },
    ])
  );
  const networkPrefix = PREFIX[network];

  const oneKeyInputs: OneKeyInput[] = txDetails.inputs.map((input, i) => {
    const pathInfo = inputPaths.get(i);
    const bip44 = pathInfo
      ? buildBip44Path(network, pathInfo.path, pathInfo.addressIndex, accountPath)
      : buildBip44Path(network, 'receive', 0, accountPath);
    return {
      address_n: oneKeyPathToAddressN(bip44),
      prev_hash: txidHex(ensureUint8Array(input.outpointTransactionHash)),
      prev_index: input.outpointIndex,
      amount: String(sourceOutputs[i]?.valueSatoshis ?? 0n),
      script_type: 'SPENDADDRESS',
    };
  });

  const oneKeyOutputs: OneKeyOutput[] = txDetails.outputs.map((output) => {
    const lcb = ensureUint8Array(output.lockingBytecode);
    const addressResult = lockingBytecodeToCashAddress({ prefix: networkPrefix, bytecode: lcb });
    const address = typeof addressResult === 'string' ? addressResult : String(addressResult);
    return { address, amount: String(output.valueSatoshis), script_type: 'PAYTOADDRESS' };
  });

  const result = await oneKeySignTransaction(oneKeyInputs, oneKeyOutputs);
  return result.serializedTx;
}
