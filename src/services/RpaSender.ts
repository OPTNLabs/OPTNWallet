// BCH RPA sender — designated-input ECDH + prefix grind.
//
// Electron Cash grinds Schnorr `ndata`. libauth's BCH Schnorr has no ndata
// hook, so this grinds input 0's nSequence instead (then re-signs every
// input, because BIP143 commits to all sequences). Destination is derived
// only from the first input's key + outpoint, so sequence is not part of
// the stealth address.
//
// Reference: electroncash/rpa/paycode.py

import {
  cashAddressToLockingBytecode,
  decodeTransaction,
  encodeTransaction,
  encodeTransactionInput,
  generateSigningSerializationBCH,
  hash256,
  hexToBin,
  binToHex,
  secp256k1,
  SigningSerializationFlag,
  type CompilationContextBCH,
  type Input,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { encodeCashAddress } from '@bitauth/libauth';
import { Network } from '../state/slices/networkSlice';
import type { TransactionOutput, UTXO } from '../types/types';
import {
  computeSharedSecret,
  derivePaymentAddress,
  type DecodedPaycode,
} from './RpaService';

const HASHTYPE =
  SigningSerializationFlag.allOutputs | SigningSerializationFlag.forkId;
const MAX_GRIND_TRIES = 100_000;

export type RpaFinalizeResult =
  | {
      ok: true;
      txHex: string;
      stealthAddress: string;
      finalOutputs: TransactionOutput[];
      grindTries: number;
    }
  | { ok: false; error: string };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function lockingOf(address: string): Uint8Array {
  const locking = cashAddressToLockingBytecode(address);
  if (typeof locking === 'string') {
    throw new Error(`Invalid cash address: ${locking}`);
  }
  return locking.bytecode;
}

function p2pkhScriptFromPubkey(pubkey: Uint8Array): Uint8Array {
  return Uint8Array.from([
    0x76, 0xa9, 0x14, ...hash160(pubkey), 0x88, 0xac,
  ]);
}

function pushScriptSig(sigWithType: Uint8Array, pubkey: Uint8Array): Uint8Array {
  return Uint8Array.from([
    sigWithType.length,
    ...sigWithType,
    pubkey.length,
    ...pubkey,
  ]);
}

function prefixHexChars(prefixBits: number): number {
  if (prefixBits === 4) return 1;
  if (prefixBits === 8) return 2;
  if (prefixBits === 12) return 3;
  if (prefixBits === 16) return 4;
  throw new Error(`Unsupported RPA prefix size: ${prefixBits} bits`);
}

/** First N hex chars of the scan pubkey *after* the 02/03 compressed prefix. */
export function rpaPrefixTargetHex(
  scanPubkey: Uint8Array,
  prefixBits: number
): string {
  const chars = prefixHexChars(prefixBits);
  return binToHex(scanPubkey).slice(2, 2 + chars).toLowerCase();
}

export function serializedInputPrefixHex(
  serializedInput: Uint8Array,
  prefixBits: number
): string {
  const chars = prefixHexChars(prefixBits);
  return binToHex(hash256(serializedInput)).slice(0, chars);
}

function sortOutputsBip69(outputs: Output[]): Output[] {
  return [...outputs].sort((a, b) => {
    if (a.valueSatoshis !== b.valueSatoshis) {
      return a.valueSatoshis < b.valueSatoshis ? -1 : 1;
    }
    const left = a.lockingBytecode;
    const right = b.lockingBytecode;
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i++) {
      if (left[i] !== right[i]) return left[i] - right[i];
    }
    return left.length - right.length;
  });
}

function signAllInputs(
  transaction: TransactionCommon,
  sourceOutputs: Output[],
  keys: Array<{ priv: Uint8Array; pub: Uint8Array }>
): void {
  for (let i = 0; i < transaction.inputs.length; i++) {
    const key = keys[i];
    const context: CompilationContextBCH = {
      inputIndex: i,
      sourceOutputs,
      transaction,
    };
    const preimage = generateSigningSerializationBCH(context, {
      coveredBytecode: p2pkhScriptFromPubkey(key.pub),
      signingSerializationType: Uint8Array.of(HASHTYPE),
    });
    const sighash = hash256(preimage);
    const sig = secp256k1.signMessageHashSchnorr(key.priv, sighash);
    if (typeof sig === 'string') {
      throw new Error(`schnorr sign failed: ${sig}`);
    }
    transaction.inputs[i].unlockingBytecode = pushScriptSig(
      Uint8Array.from([...sig, HASHTYPE]),
      key.pub
    );
  }
}

function cashAddressFromLocking(
  locking: Uint8Array,
  network: Network
): string {
  const pkh =
    locking.length === 25 && locking[0] === 0x76 && locking[2] === 0x14
      ? locking.slice(3, 23)
      : hash160(locking);
  const encoded = encodeCashAddress({
    prefix: network === Network.MAINNET ? 'bitcoincash' : 'bchtest',
    type: 'p2pkh',
    payload: pkh,
  });
  if (typeof encoded === 'string') {
    throw new Error(`Address encode failed: ${encoded}`);
  }
  return encoded.address;
}

function outputsForReview(
  transaction: TransactionCommon,
  network: Network
): TransactionOutput[] {
  return transaction.outputs.map((output) => ({
    recipientAddress: cashAddressFromLocking(output.lockingBytecode, network),
    amount: output.valueSatoshis,
  }));
}

/**
 * Take a dummy-destination signed (or unsigned) tx, swap in the stealth
 * output derived from input 0, re-sign, and grind input 0's sequence until
 * the serialized-input hash prefix matches the paycode scan prefix.
 */
export async function finalizeRpaPayment(args: {
  rawTxHex: string;
  dummyAddress: string;
  paycode: DecodedPaycode;
  utxos: UTXO[];
  inputKeys: Array<{ priv: Uint8Array; pub: Uint8Array }>;
  network: Network;
}): Promise<RpaFinalizeResult> {
  const { rawTxHex, dummyAddress, paycode, utxos, inputKeys, network } = args;
  if (paycode.expiry !== 0) {
    const oneWeek = Math.floor(Date.now() / 1000) + 604_800;
    if (paycode.expiry < oneWeek) {
      return { ok: false, error: 'This paycode has expired.' };
    }
  }
  if (inputKeys.length === 0 || utxos.length === 0) {
    return { ok: false, error: 'No coins selected for this paycode send.' };
  }
  if (inputKeys.length !== utxos.length) {
    return { ok: false, error: 'Missing a signing key for a selected coin.' };
  }

  const decoded = decodeTransaction(hexToBin(rawTxHex));
  if (typeof decoded === 'string') {
    return { ok: false, error: `Could not read the draft transaction: ${decoded}` };
  }
  const transaction = decoded as TransactionCommon;
  if (transaction.inputs.length !== utxos.length) {
    return {
      ok: false,
      error: 'Draft transaction inputs do not match the selected coins.',
    };
  }

  const dummyLocking = lockingOf(dummyAddress);
  const dummyIndex = transaction.outputs.findIndex((output) =>
    bytesEqual(output.lockingBytecode, dummyLocking)
  );
  if (dummyIndex < 0) {
    return { ok: false, error: 'Internal error: dummy paycode output is missing.' };
  }

  const first = utxos[0];
  const shared = computeSharedSecret(
    inputKeys[0].priv,
    paycode.scanPubkey,
    first.tx_hash,
    first.tx_pos
  );
  const stealthAddress = derivePaymentAddress(
    paycode.spendPubkey,
    shared,
    network,
    0
  );
  const stealthLocking = lockingOf(stealthAddress);
  transaction.outputs[dummyIndex] = {
    ...transaction.outputs[dummyIndex],
    lockingBytecode: stealthLocking,
  };
  transaction.outputs = sortOutputsBip69(transaction.outputs);

  if (
    transaction.outputs.some((output) =>
      bytesEqual(output.lockingBytecode, dummyLocking)
    )
  ) {
    return { ok: false, error: 'Internal error: dummy destination was not replaced.' };
  }
  if (
    !transaction.outputs.some((output) =>
      bytesEqual(output.lockingBytecode, stealthLocking)
    )
  ) {
    return { ok: false, error: 'Internal error: stealth destination was not written.' };
  }

  const sourceOutputs: Output[] = utxos.map((utxo, i) => ({
    lockingBytecode: p2pkhScriptFromPubkey(inputKeys[i].pub),
    valueSatoshis: BigInt(utxo.amount ?? utxo.value ?? 0),
  }));

  const target = rpaPrefixTargetHex(paycode.scanPubkey, paycode.prefixBits);
  const startSequence = transaction.inputs[0].sequenceNumber >>> 0;
  let grindTries = 0;
  let matched: Input | null = null;

  for (let offset = 0; offset < MAX_GRIND_TRIES; offset++) {
    grindTries = offset + 1;
    transaction.inputs[0].sequenceNumber = (startSequence + offset) >>> 0;
    signAllInputs(transaction, sourceOutputs, inputKeys);
    const serialized = encodeTransactionInput(transaction.inputs[0]);
    if (serializedInputPrefixHex(serialized, paycode.prefixBits) === target) {
      matched = transaction.inputs[0];
      break;
    }
    if (offset % 64 === 63) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }

  if (!matched) {
    return {
      ok: false,
      error:
        'Could not find a matching signature prefix for this paycode. Try again with a different coin.',
    };
  }

  const txHex = binToHex(encodeTransaction(transaction));
  return {
    ok: true,
    txHex,
    stealthAddress,
    finalOutputs: outputsForReview(transaction, network),
    grindTries,
  };
}

export function makeRpaDummyAddress(network: Network): string {
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  const pub = secp256k1.derivePublicKeyCompressed(entropy);
  if (typeof pub === 'string') {
    throw new Error(`Dummy key failed: ${pub}`);
  }
  entropy.fill(0);
  const encoded = encodeCashAddress({
    prefix: network === Network.MAINNET ? 'bitcoincash' : 'bchtest',
    type: 'p2pkh',
    payload: hash160(pub),
  });
  if (typeof encoded === 'string') throw new Error(encoded);
  return encoded.address;
}
