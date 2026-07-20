// P2P CashFusion signing — Phase 4b. Turns an assembled CoinJoin (fusionRound.ts)
// into signatures for the local wallet's own inputs, and stitches everyone's
// signatures into the final raw transaction the coordinator broadcasts.
//
// Reuses the wallet's existing libauth signing path (the same one used for
// WalletConnect spends): BIP143 preimage via generateSigningSerializationBCH,
// SIGHASH_ALL|FORKID (0x41), Schnorr sign. Because 0x41 does NOT set
// SIGHASH_UTXOS, a peer's own-input preimage commits only to all outpoints, all
// outputs, and THAT input's own scriptCode+value — so a peer can sign its inputs
// without ever learning other peers' prevout scripts. No new Rust, no second
// crypto stack: the P2P transport stays entirely in the WebView.

import {
  encodeLockingBytecodeP2pkh,
  encodeTransaction,
  generateSigningSerializationBCH,
  SigningSerializationFlag,
  secp256k1,
  hash256,
  hexToBin,
  binToHex,
  type CompilationContextBCH,
  type TransactionCommon,
  type Output,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import type { AssembledFusionTx } from './fusionRound';

const SEQUENCE = 0xffffffff;
const TX_VERSION = 2;
/** SIGHASH_ALL | FORKID (0x41) — a standard BCH P2PKH spend, no SIGHASH_UTXOS. */
const HASHTYPE = SigningSerializationFlag.allOutputs | SigningSerializationFlag.forkId;

/** P2PKH locking script for a compressed pubkey (hex). */
function p2pkhScript(pubkeyHex: string): Uint8Array {
  return encodeLockingBytecodeP2pkh(hash160(hexToBin(pubkeyHex)));
}

/** A finished scriptSig for one input, keyed by its outpoint. */
export interface InputSig {
  prevTxid: string;
  prevIndex: number;
  unlockingBytecode: string; // hex: push(sig||0x41) push(pubkey)
}

/**
 * Build the libauth transaction template + sourceOutputs for the assembled
 * CoinJoin. Every FusionInputRef carries the input's pubkey and value, so the
 * P2PKH source scripts are fully reconstructible without any peer's prevout tx.
 */
export function toLibauthTx(tx: AssembledFusionTx): {
  transaction: TransactionCommon;
  sourceOutputs: Output[];
} {
  const transaction: TransactionCommon = {
    version: TX_VERSION,
    locktime: 0,
    inputs: tx.inputs.map((i) => ({
      // display (big-endian) txid → internal little-endian outpoint hash
      outpointTransactionHash: hexToBin(i.prevTxid).reverse(),
      outpointIndex: i.prevIndex,
      sequenceNumber: SEQUENCE,
      unlockingBytecode: Uint8Array.of(),
    })),
    outputs: tx.outputs.map((o) => ({
      lockingBytecode: hexToBin(o.script),
      valueSatoshis: BigInt(o.value),
    })),
  };
  const sourceOutputs: Output[] = tx.inputs.map((i) => ({
    lockingBytecode: p2pkhScript(i.pubkey),
    valueSatoshis: BigInt(i.value),
  }));
  return { transaction, sourceOutputs };
}

/**
 * Sign every input whose pubkey the caller holds the private key for. Returns a
 * scriptSig per signed input; other peers sign theirs the same way and the
 * coordinator merges them (finalizeFusionTx). Only ever produces signatures for
 * this wallet's own coins.
 */
export function signMyInputs(
  tx: AssembledFusionTx,
  keysByPubkey: Map<string, Uint8Array>
): InputSig[] {
  const { transaction, sourceOutputs } = toLibauthTx(tx);
  const sigs: InputSig[] = [];
  tx.inputs.forEach((inp, i) => {
    const priv = keysByPubkey.get(inp.pubkey);
    if (!priv) return;
    const context: CompilationContextBCH = { inputIndex: i, sourceOutputs, transaction };
    const preimage = generateSigningSerializationBCH(context, {
      coveredBytecode: p2pkhScript(inp.pubkey),
      signingSerializationType: Uint8Array.of(HASHTYPE),
    });
    const sighash = hash256(preimage);
    const sig = secp256k1.signMessageHashSchnorr(priv, sighash);
    if (typeof sig === 'string') throw new Error(`schnorr sign failed: ${sig}`);
    const sigWithType = Uint8Array.from([...sig, HASHTYPE]); // 65 bytes
    const pub = hexToBin(inp.pubkey); // 33 bytes
    // scriptSig: OP_PUSH65 <sig+type> OP_PUSH33 <pubkey> (both single-byte pushdata)
    const scriptSig = Uint8Array.from([sigWithType.length, ...sigWithType, pub.length, ...pub]);
    sigs.push({ prevTxid: inp.prevTxid, prevIndex: inp.prevIndex, unlockingBytecode: binToHex(scriptSig) });
  });
  return sigs;
}

/**
 * Coordinator step: fill every input's scriptSig from the collected signatures
 * and encode the final transaction. Throws if any input is unsigned.
 */
export function finalizeFusionTx(
  tx: AssembledFusionTx,
  sigs: InputSig[]
): { txHex: string; txid: string; transaction: TransactionCommon; sourceOutputs: Output[] } {
  const { transaction, sourceOutputs } = toLibauthTx(tx);
  const byOutpoint = new Map(sigs.map((s) => [`${s.prevTxid}:${s.prevIndex}`, s.unlockingBytecode]));
  transaction.inputs.forEach((inp, i) => {
    const key = `${tx.inputs[i].prevTxid}:${tx.inputs[i].prevIndex}`;
    const u = byOutpoint.get(key);
    if (!u) throw new Error(`missing signature for input ${key}`);
    inp.unlockingBytecode = hexToBin(u);
  });
  const raw = encodeTransaction(transaction);
  const txid = binToHex(hash256(raw).reverse());
  return { txHex: binToHex(raw), txid, transaction, sourceOutputs };
}
