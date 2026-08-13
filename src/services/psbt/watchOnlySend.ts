// Watch-only send builder: selected coin-controlled UTXOs -> unsigned PSBT.
//
// The online watch-only wallet builds the unsigned transaction and carries it
// to an air-gapped signer as a PSBT (v145, BIP32 derivation metadata per
// input, SIGHASH_ALL|FORKID|ANYONECANPAY = 0xc1). No private key ever enters
// this code path: the signer is a different device (SeedCash).
//
// Fee policy is the same relay-margin policy the signed path uses
// (relayFeeForBytes in TransactionManager/feePolicy.ts), so the user sees one
// consistent number no matter which wallet type they are in. The change output
// is only added when the leftover survives the dust threshold, exactly like the
// planner does for signed sends.

import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeTransaction,
  hexToBin,
} from '@bitauth/libauth';

import { DUST } from '../../utils/constants';
import { relayFeeForBytes } from '../../apis/TransactionManager/feePolicy';
import {
  encodeUnsignedPsbt,
  SIGHASH_ALL_FORKID_ANYONECANPAY,
  type PsbtInputSpec,
  type PsbtOutputSpec,
} from './psbtBch';
import { p2shLockingBytecodeFor } from './psbtMultisig';

/**
 * A UTXO chosen by coin control, with the public-key derivation needed for the
 * signer to claim it. Everything here is public material.
 */
export interface WatchOnlyInputSpec {
  txid: string;
  vout: number;
  satoshis: bigint;
  /** Locking bytecode of the output being spent, hex. */
  lockingBytecodeHex: string;
  /** Compressed public key (33 bytes) that must sign this input, hex. */
  publicKeyHex: string;
  /** BIP44 branch: 0 = receive, 1 = change. */
  branchIndex: 0 | 1;
  addressIndex: number;
  /**
   * Raw parent transaction, hex — the one this input spends.
   *
   * Written into the PSBT as PSBT_IN_NON_WITNESS_UTXO, which is what Paytaca
   * emits and the only spent-output field SeedCash reads without corrupting
   * the script it signs over. Optional on the type so fixtures and
   * PSBT-to-PSBT paths still compile, but a proposal headed for a real signer
   * must carry it; `buildWatchOnlyPsbt` refuses without it.
   */
  previousTransactionHex?: string;
  /**
   * Present on multisig (P2SH) inputs: the `OP_m <keys> OP_n OP_CHECKMULTISIG`
   * redeem script whose hash160 is the locking bytecode above.
   */
  redeemScriptHex?: string;
  /** Signatures required for this input: 1 for P2PKH, m for multisig. */
  requiredSignatures?: number;
  /**
   * Every cosigner key that participates in this input's redeem script, so
   * the PSBT tells the signer about all of them (one BIP32 derivation each).
   */
  cosignerDerivations?: {
    publicKeyHex: string;
    masterFingerprintHex: string;
    /** Full path from the master key, e.g. m/44'/145'/0'/0/0. */
    derivationPath: string;
  }[];
}

export interface WatchOnlyBuildParams {
  inputs: WatchOnlyInputSpec[];
  /** Destination cashaddr. */
  recipient: string;
  amountSats: bigint;
  /** Change cashaddr (the wallet's own address). */
  changeAddress: string;
  /** Account path of the wallet, e.g. m/44'/145'/0'. */
  accountPath: string;
  /** 4-byte master fingerprint, from the signing device. */
  masterFingerprint: Uint8Array | null;
  /**
   * Multisig change output: when the wallet spends P2SH inputs, the change
   * must go back to the same policy, with one derivation per cosigner key so
   * every signer recognises it.
   */
  changeRedeemScriptHex?: string;
  changeDerivations?: WatchOnlyInputSpec['cosignerDerivations'];
}

export interface WatchOnlyBuildOutput {
  lockingBytecodeHex: string;
  satoshis: bigint;
  isChange: boolean;
}

export interface WatchOnlyBuildResult {
  /** The binary PSBT to hand to the signer. */
  psbtBytes: Uint8Array;
  /** The unsigned transaction inside the PSBT, hex. */
  rawUnsignedHex: string;
  outputs: WatchOnlyBuildOutput[];
  feeSats: bigint;
  changeSats: bigint;
  inputSumSats: bigint;
  /** Master fingerprint used, or null when the wallet has none yet. */
  masterFingerprint: Uint8Array | null;
  /**
   * Whether the signing device will show these inputs as its own.
   *
   * False means the PSBT still signs and broadcasts correctly — the signature
   * is made from the derivation path, not the fingerprint — but SeedCash's
   * review screen will not claim the inputs, so the user is approving a
   * transaction the device cannot confirm belongs to them. Warn, do not block.
   */
  signerRecognisesInputs: boolean;
}

/** What the signer is asked to authorise — everything the import binds to. */
export interface WatchOnlyProposal {
  rawUnsignedHex: string;
  inputs: WatchOnlyInputSpec[];
  outputs: WatchOnlyBuildOutput[];
}

const HARDENED_INDEX = 0x80000000;

/** Sighash type the signer is asked for — the watch-only contract. */
export const WATCH_ONLY_SIGHASH_TYPE = SIGHASH_ALL_FORKID_ANYONECANPAY;

/** The unlocking script shape is fixed here: P2PKH with an ECDSA signature. */
export const P2PKH_UNLOCK_BYTES = 108;

export function p2pkhInputBytes(): number {
  return 32 + 4 + 1 + P2PKH_UNLOCK_BYTES + 4;
}

export function p2pkhOutputBytes(): number {
  return 8 + 1 + 25;
}

export function estimateUnsignedSize(
  inputCount: number,
  outputCount: number
): number {
  return 4 + 1 + 1 + 4 + inputCount * p2pkhInputBytes() + outputCount * p2pkhOutputBytes();
}

function addressToLockingBytecode(address: string): Uint8Array {
  const result = cashAddressToLockingBytecode(address);
  if (typeof result === 'string') {
    throw new Error(`Invalid destination address: ${result}`);
  }
  return Uint8Array.from(result.bytecode);
}

function pathToDerivation(accountPath: string, branch: 0 | 1, index: number): number[] {
  const match = /^m\/44'\/(\d+)'\/(\d+)'$/.exec(accountPath.trim());
  if (!match) {
    throw new Error("Derivation path must match m/44'/coinType'/accountIndex'.");
  }
  return [
    HARDENED_INDEX | 44,
    HARDENED_INDEX | Number(match[1]),
    HARDENED_INDEX | Number(match[2]),
    branch,
    index,
  ];
}

/** `m/44'/145'/0'/0/0` (cosigner paths) -> hardened-OR-ed level array. */
export function parseBip32PathString(path: string): number[] {
  const match = /^m\/(.+)$/.exec(path.trim());
  if (!match) {
    throw new Error(`Derivation path must start with m/ (got "${path}").`);
  }
  return match[1].split('/').map((level) => {
    const hardened = level.endsWith("'");
    const raw = hardened ? level.slice(0, -1) : level;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
      throw new Error(`Invalid derivation path level "${level}".`);
    }
    return hardened ? value | HARDENED_INDEX : value;
  });
}

function inputSpecToPsbt(
  input: WatchOnlyInputSpec,
  accountPath: string
): PsbtInputSpec {
  const derivations = input.cosignerDerivations?.map((cosigner) => {
    const masterFingerprint = hexToBin(cosigner.masterFingerprintHex);
    if (masterFingerprint.length !== 4) {
      throw new Error(
        `Cosigner master fingerprint must be 4 bytes (got "${cosigner.masterFingerprintHex}").`
      );
    }
    return {
      publicKey: hexToBin(cosigner.publicKeyHex),
      masterFingerprint,
      derivationPath: parseBip32PathString(cosigner.derivationPath),
    };
  });
  return {
    txid: input.txid,
    vout: input.vout,
    satoshis: input.satoshis,
    lockingBytecode: hexToBin(input.lockingBytecodeHex),
    publicKey: derivations
      ? new Uint8Array()
      : hexToBin(input.publicKeyHex),
    masterFingerprint: new Uint8Array(4),
    derivationPath: pathToDerivation(accountPath, input.branchIndex, input.addressIndex),
    redeemScript: input.redeemScriptHex
      ? hexToBin(input.redeemScriptHex)
      : undefined,
    previousTransaction: input.previousTransactionHex
      ? hexToBin(input.previousTransactionHex)
      : undefined,
    derivations,
    sequence: 0xffffffff,
  };
}

/**
 * Build the unsigned transaction + PSBT for the selected coins.
 *
 * Throws with a message aimed at the person doing the send when the inputs do
 * not cover the amount and fee, the fingerprint is missing (the signer would
 * refuse the inputs), or an address cannot be encoded.
 */
export function buildWatchOnlyPsbt(
  params: WatchOnlyBuildParams
): WatchOnlyBuildResult {
  if (params.inputs.length === 0) {
    throw new Error('Select at least one input (coin control).');
  }
  if (params.amountSats <= 0n) {
    throw new Error('Amount must be greater than 0.');
  }
  // The master fingerprint is NOT required to produce a signable, valid
  // transaction, and it is not derivable from the account xPub — measured, not
  // assumed. For the BIP39 vector the three candidates all differ:
  //
  //   SeedCash's own value      73c5da0a  = hash160(master pubkey)[:4], at m
  //   the xPub's parent fp      2b72f5b7  = m/44'/145'
  //   the account key's own fp  cba3794d
  //
  // and a watch-only wallet never sees the master key. What matters is that
  // SeedCash's `sign_psbt_with_xpriv` reads only the *path* out of the 0x06
  // record (`_, derivation_path = parse_bip32_derivation_value(v)`) and
  // discards the fingerprint entirely. Signing a PSBT stamped with a
  // deliberately wrong fingerprint was verified to produce a signature that
  // this codec accepts and that libauth's BCH VM executes.
  //
  // What the fingerprint does buy is the device's REVIEW screen: SeedCash
  // claims an input as its own via `v[:4] == wallet_fingerprint`, so without a
  // match it displays a transaction it does not recognise and the user is
  // blind-signing. So it is optional, not free — the caller is told which case
  // it is via `signerRecognisesInputs` and warns accordingly.
  //
  // Zeros rather than omission: dropping the 0x06 record entirely would leave
  // SeedCash with no derivation path at all and it would refuse to sign
  // ("xpriv signing requires a PSBT derivation path").
  const fingerprintKnown =
    !!params.masterFingerprint && params.masterFingerprint.length === 4;
  const masterFingerprint = fingerprintKnown
    ? Uint8Array.from(params.masterFingerprint!)
    : new Uint8Array(4);
  // Without the parent transaction the PSBT falls back to the compact
  // WITNESS_UTXO field, which SeedCash mis-slices — it would sign a hash over
  // a script one byte longer than the one we verify, and every signature would
  // come back "invalid" with nothing on screen explaining why. Refuse instead.
  const missingParent = params.inputs.findIndex(
    (input) => !input.previousTransactionHex
  );
  if (missingParent !== -1) {
    throw new Error(
      `The parent transaction for coin ${missingParent + 1} was not loaded. ` +
        'The signer needs it to confirm the amount being spent; try building ' +
        'again once the wallet is connected.'
    );
  }

  const recipientBytecode = addressToLockingBytecode(params.recipient);
  const changeBytecode = addressToLockingBytecode(params.changeAddress);
  const inputSum = params.inputs.reduce(
    (sum, input) => sum + input.satoshis,
    0n
  );

  // Fee depends on whether a change output survives; iterate to a fixed point
  // (never more than twice in practice).
  let outputs: { bytecode: Uint8Array; satoshis: bigint; isChange: boolean }[] = [
    { bytecode: recipientBytecode, satoshis: params.amountSats, isChange: false },
  ];
  let changeSats = 0n;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fee = relayFeeForBytes(
      estimateUnsignedSize(params.inputs.length, outputs.length)
    );
    const leftover = inputSum - params.amountSats - fee;
    if (leftover < 0n) {
      throw new Error(
        `Selected inputs cover ${inputSum.toString()} sats; ` +
          `${(params.amountSats + fee).toString()} sats are needed ` +
          `(amount + fee). Add more inputs or lower the amount.`
      );
    }
    const nextChange = leftover >= DUST ? leftover : 0n;
    const withChange = [
      { bytecode: recipientBytecode, satoshis: params.amountSats, isChange: false },
    ];
    if (nextChange > 0n) {
      withChange.push({
        bytecode: changeBytecode,
        satoshis: nextChange,
        isChange: true,
      });
    }
    if (withChange.length === outputs.length && nextChange === changeSats) {
      break;
    }
    outputs = withChange;
    changeSats = nextChange;
  }

  const feeSats = inputSum - params.amountSats - changeSats;
  const psbtInputs: PsbtInputSpec[] = params.inputs.map((input) => ({
    ...inputSpecToPsbt(input, params.accountPath),
    masterFingerprint,
  }));
  const changeOutput: PsbtOutputSpec = {
    lockingBytecode: changeBytecode,
    satoshis: changeSats,
  };
  if (!!params.changeRedeemScriptHex !== !!params.changeDerivations) {
    throw new Error(
      'Multisig change needs both the redeem script and cosigner derivations.'
    );
  }
  if (params.changeRedeemScriptHex && params.changeDerivations) {
    const changeDerivations = params.changeDerivations.map((cosigner) => {
      const fingerprint = hexToBin(cosigner.masterFingerprintHex);
      if (fingerprint.length !== 4) {
        throw new Error(
          `Cosigner master fingerprint must be 4 bytes (got "${cosigner.masterFingerprintHex}").`
        );
      }
      return {
        publicKey: hexToBin(cosigner.publicKeyHex),
        masterFingerprint: fingerprint,
        derivationPath: parseBip32PathString(cosigner.derivationPath),
      };
    });
    // Multisig change goes back to the same P2SH policy, not to the wallet's
    // P2PKH change address: the next spend has to be signed by the same
    // cosigners, so the signer must see this output as its own.
    changeOutput.lockingBytecode = p2shLockingBytecodeFor(
      hexToBin(params.changeRedeemScriptHex)
    );
    changeOutput.redeemScript = hexToBin(params.changeRedeemScriptHex);
    changeOutput.derivations = changeDerivations;
  }
  const psbtOutputs: PsbtOutputSpec[] = outputs.map((output) =>
    output.isChange ? changeOutput : { lockingBytecode: output.bytecode, satoshis: output.satoshis }
  );
  const psbtBytes = encodeUnsignedPsbt(
    psbtInputs,
    psbtOutputs,
    WATCH_ONLY_SIGHASH_TYPE
  );
  const rawUnsigned = encodeTransaction({
    version: 2,
    inputs: params.inputs.map((input) => ({
      outpointTransactionHash: hexToBin(input.txid),
      outpointIndex: input.vout,
      unlockingBytecode: Uint8Array.of(),
      sequenceNumber: 0xffffffff,
    })),
    outputs: outputs.map((output) => ({
      lockingBytecode: output.bytecode,
      valueSatoshis: output.satoshis,
    })),
    locktime: 0,
  });

  return {
    psbtBytes,
    rawUnsignedHex: binToHex(rawUnsigned),
    outputs: outputs.map((output) => ({
      lockingBytecodeHex: binToHex(output.bytecode),
      satoshis: output.satoshis,
      isChange: output.isChange,
    })),
    feeSats,
    changeSats,
    inputSumSats: inputSum,
    masterFingerprint: fingerprintKnown ? masterFingerprint : null,
    signerRecognisesInputs: fingerprintKnown,
  };
}
