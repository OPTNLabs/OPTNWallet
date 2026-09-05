// Watch-only send builder: selected coin-controlled UTXOs -> unsigned PSBT.
//
// The online watch-only wallet builds the unsigned transaction and carries it
// to an air-gapped signer as a PSBT (v145, BIP32 derivation metadata per
// input, with an explicit BCH sighash type). No private key ever enters
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
  decodeCashAddress,
  encodeTransaction,
  hexToBin,
} from '@bitauth/libauth';

import { DUST } from '../../utils/constants';
import { relayFeeForBytes } from '../../apis/TransactionManager/feePolicy';
import {
  encodeUnsignedPsbt,
  psbtTokenToTransactionToken,
  SIGHASH_ALL_FORKID,
  type PsbtInputSpec,
  type PsbtOutputSpec,
  type PsbtTokenSpec,
} from './psbtBch';
import {
  parseMultisigRedeemScript,
  p2shLockingBytecodeFor,
} from './psbtMultisig';
import {
  stableCosignerId,
  type MultisigDerivedCosigner,
  type MultisigPolicy,
} from './multisigWallet';

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
  /** Authoritative token state read from the complete parent transaction. */
  token?: PsbtTokenSpec;
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
  /** BCH signature commitments. Defaults to ALL|FORKID (0x41). */
  sighashType?: number;
  recipientToken?: PsbtTokenSpec;
  changeToken?: PsbtTokenSpec;
  /** Explicit authority for a token transition; omitted means preserve state. */
  tokenIntent?:
    | 'preserve'
    | 'mutable-commitment'
    | 'minting-capability'
    | 'burn';
  /** Optional per-byte fee override; omitted uses the wallet relay-margin policy. */
  feeRateSatPerByte?: number;
}

export type WatchOnlyCosignerDerivation = NonNullable<
  WatchOnlyInputSpec['cosignerDerivations']
>[number];

/**
 * Pair each policy cosigner with that cosigner's derived key. The derived
 * keys are BIP-67 sorted for the redeem script, so their array position must
 * never be used as the cosigner identity.
 */
export function multisigCosignerDerivations(
  policy: MultisigPolicy,
  derivedCosigners: MultisigDerivedCosigner[],
  branchIndex: 0 | 1,
  addressIndex: number,
  fallbackAccountPath: string
): WatchOnlyCosignerDerivation[] {
  return policy.signers.map((signer, index) => {
    const cosignerId =
      signer.id?.trim() || stableCosignerId(signer.xpub.trim());
    const derived = derivedCosigners.find(
      (candidate) => candidate.cosignerId === cosignerId
    );
    if (!derived) {
      throw new Error(
        `Could not map derived key for cosigner ${index + 1} at ${branchIndex}/${addressIndex}.`
      );
    }
    return {
      publicKeyHex: binToHex(derived.publicKey),
      masterFingerprintHex: signer.masterFingerprintHex ?? '00000000',
      derivationPath: `${signer.accountPath ?? fallbackAccountPath}/${branchIndex}/${addressIndex}`,
    };
  });
}

export interface WatchOnlyBuildOutput {
  lockingBytecodeHex: string;
  satoshis: bigint;
  isChange: boolean;
  token?: PsbtTokenSpec;
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
  /** Exact sighash requested on every input and required on import. */
  sighashType: number;
}

/** What the signer is asked to authorise — everything the import binds to. */
export interface WatchOnlyProposal {
  rawUnsignedHex: string;
  inputs: WatchOnlyInputSpec[];
  outputs: WatchOnlyBuildOutput[];
  /** Exact sighash the user approved and the signer must return. */
  sighashType: number;
}

function tokenAmount(token: PsbtTokenSpec | undefined): bigint {
  return token?.amount ?? 0n;
}

function tokenKey(token: PsbtTokenSpec): string {
  return binToHex(token.category);
}

function tokenIdentity(token: PsbtTokenSpec): string {
  return `${tokenKey(token)}:${token.capability ?? 0}:${binToHex(
    token.commitment ?? new Uint8Array()
  )}`;
}

function assertTokenAddress(address: string, label: string): void {
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string') {
    throw new Error(`${label} is not a valid CashAddr.`);
  }
  if (decoded.type !== 'p2shWithTokens' && decoded.type !== 'p2pkhWithTokens') {
    throw new Error(`${label} must be token-aware when it carries CashTokens.`);
  }
}

function validateTokenPlan(
  inputs: WatchOnlyInputSpec[],
  recipientToken: PsbtTokenSpec | undefined,
  changeToken: PsbtTokenSpec | undefined,
  recipient: string,
  changeAddress: string,
  intent: WatchOnlyBuildParams['tokenIntent'] = 'preserve'
): void {
  const inputTokens = inputs
    .map((input) => input.token)
    .filter(Boolean) as PsbtTokenSpec[];
  const outputTokens = [recipientToken, changeToken].filter(
    Boolean
  ) as PsbtTokenSpec[];
  if (inputTokens.length === 0 && outputTokens.length === 0) return;
  if (inputTokens.length === 0) {
    throw new Error(
      'Token outputs cannot be created without token-bearing inputs.'
    );
  }
  if (!recipientToken && !changeToken) {
    throw new Error(
      'Token-bearing inputs require an explicit recipient or change token output.'
    );
  }
  if (recipientToken) assertTokenAddress(recipient, 'Token recipient');
  if (changeToken) assertTokenAddress(changeAddress, 'Token change');

  const inputFungible = new Map<string, bigint>();
  const outputFungible = new Map<string, bigint>();
  for (const token of inputTokens) {
    const key = tokenKey(token);
    inputFungible.set(key, (inputFungible.get(key) ?? 0n) + tokenAmount(token));
  }
  for (const token of outputTokens) {
    const key = tokenKey(token);
    outputFungible.set(
      key,
      (outputFungible.get(key) ?? 0n) + tokenAmount(token)
    );
  }
  for (const [category, amount] of inputFungible) {
    const outputAmount = outputFungible.get(category) ?? 0n;
    if (
      outputAmount > amount ||
      (outputAmount !== amount && intent !== 'burn')
    ) {
      throw new Error(
        `Token category ${category} is not conserved between inputs and outputs.`
      );
    }
  }
  for (const category of outputFungible.keys()) {
    if (!inputFungible.has(category)) {
      throw new Error(`Token category ${category} is not present in an input.`);
    }
  }

  const inputNfts = new Map<string, number>();
  const outputNfts = new Map<string, number>();
  for (const token of inputTokens) {
    if (token.capability === undefined && token.commitment === undefined)
      continue;
    const key = tokenIdentity(token);
    inputNfts.set(key, (inputNfts.get(key) ?? 0) + 1);
  }
  for (const token of outputTokens) {
    if (token.capability === undefined && token.commitment === undefined)
      continue;
    const key = tokenIdentity(token);
    outputNfts.set(key, (outputNfts.get(key) ?? 0) + 1);
  }
  if (inputNfts.size > 0 && intent === 'mutable-commitment') {
    if (
      inputNfts.size !== 1 ||
      outputNfts.size !== 1 ||
      inputTokens.length !== 1 ||
      outputTokens.length !== 1 ||
      inputTokens[0].capability !== 1 ||
      outputTokens[0].capability !== 1 ||
      tokenKey(inputTokens[0]) !== tokenKey(outputTokens[0])
    ) {
      throw new Error(
        'Mutable NFT commitment changes require one mutable NFT input and one mutable NFT output.'
      );
    }
    if (tokenIdentity(inputTokens[0]) === tokenIdentity(outputTokens[0])) {
      throw new Error(
        'Mutable NFT commitment intent must change the commitment.'
      );
    }
    return;
  }
  if (inputNfts.size > 0 && intent === 'minting-capability') {
    if (
      inputNfts.size !== 1 ||
      outputNfts.size !== 1 ||
      inputTokens.length !== 1 ||
      outputTokens.length !== 1 ||
      inputTokens[0].capability !== 2 ||
      tokenKey(inputTokens[0]) !== tokenKey(outputTokens[0])
    ) {
      throw new Error(
        'Minting capability transitions require one minting NFT input and one same-category NFT output.'
      );
    }
    if (tokenIdentity(inputTokens[0]) === tokenIdentity(outputTokens[0])) {
      throw new Error(
        'Minting capability intent must change the NFT capability.'
      );
    }
    return;
  }
  for (const [identity, count] of inputNfts) {
    if (outputNfts.get(identity) !== count) {
      throw new Error(
        `NFT ${identity} must have exactly one valid continuation per input.`
      );
    }
  }
  for (const identity of outputNfts.keys()) {
    if (!inputNfts.has(identity)) {
      throw new Error(`NFT ${identity} is not present in an input.`);
    }
  }
}

const HARDENED_INDEX = 0x80000000;

/** Sighash type the signer is asked for — the watch-only contract. */
export const WATCH_ONLY_SIGHASH_TYPE = SIGHASH_ALL_FORKID;

/** The unlocking script shape is fixed here: P2PKH with an ECDSA signature. */
export const P2PKH_UNLOCK_BYTES = 108;

export function p2pkhInputBytes(): number {
  return 32 + 4 + 1 + P2PKH_UNLOCK_BYTES + 4;
}

export function p2pkhOutputBytes(): number {
  return 8 + 1 + 25;
}

function pushDataBytes(payloadLength: number): number {
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) {
    throw new Error('Push-data length must be a non-negative safe integer.');
  }
  return payloadLength <= 75
    ? 1 + payloadLength
    : payloadLength <= 0xff
      ? 2 + payloadLength
      : payloadLength <= 0xffff
        ? 3 + payloadLength
        : 5 + payloadLength;
}

/**
 * Conservative final unlocking-script size for one input.
 *
 * The PSBT is built before signatures exist, so multisig inputs are sized for
 * the largest supported ECDSA signature and the largest Schnorr checkbits
 * push. This deliberately overestimates the usual Schnorr transaction by a
 * few bytes, which is preferable to producing a transaction below the relay
 * floor after signatures are merged.
 */
export function estimateUnlockingScriptBytes(
  input: WatchOnlyInputSpec
): number {
  if (!input.redeemScriptHex) return P2PKH_UNLOCK_BYTES;

  const redeemScript = hexToBin(input.redeemScriptHex);
  const policy = parseMultisigRedeemScript(redeemScript);
  if (!policy) {
    throw new Error('Multisig input has an invalid redeem script.');
  }
  const required = input.requiredSignatures ?? policy.requiredSignatures;
  if (
    !Number.isSafeInteger(required) ||
    required < 1 ||
    required > policy.totalSignatures
  ) {
    throw new Error('Multisig input has an invalid required signature count.');
  }

  // Schnorr checkbits are fixed-width bytes pushed as one stack element. The
  // ECDSA OP_0 dummy is smaller, so this is a safe upper bound for either
  // supported signature algorithm.
  const checkbitsDummyBytes = 1 + Math.ceil(policy.totalSignatures / 8);
  return (
    checkbitsDummyBytes +
    required * pushDataBytes(73) +
    pushDataBytes(redeemScript.length)
  );
}

type FeeEstimateOutput = {
  bytecode: Uint8Array;
  satoshis: bigint;
  token?: PsbtTokenSpec;
};

/** Size the final transaction shape, including P2SH unlocks and CashTokens. */
export function estimateFinalTransactionBytes(
  inputs: WatchOnlyInputSpec[],
  outputs: FeeEstimateOutput[]
): number {
  const encoded = encodeTransaction({
    version: 2,
    inputs: inputs.map((input) => ({
      outpointTransactionHash: hexToBin(input.txid),
      outpointIndex: input.vout,
      unlockingBytecode: new Uint8Array(estimateUnlockingScriptBytes(input)),
      sequenceNumber: 0xffffffff,
    })),
    outputs: outputs.map((output) => ({
      lockingBytecode: output.bytecode,
      valueSatoshis: output.satoshis,
      ...(output.token
        ? { token: psbtTokenToTransactionToken(output.token) }
        : {}),
    })),
    locktime: 0,
  });
  return encoded.length;
}

/**
 * Which fee rate a watch-only send should use.
 *
 * Three inputs, one answer, and no view state — the screen only supplies the
 * numbers. `undefined` out means "no explicit rate", which every caller
 * resolves through the shared relay policy, so the wallet default is expressed
 * by *not* naming a rate rather than by naming one here. That matters: a
 * number invented in this file would be a second fee policy, and the reason
 * this exists at all is that watch-only had one — a hardcoded 1 sat/byte for
 * multisig, below the 1.1 relay floor the rest of the wallet uses.
 *
 * Precedence is per-send first, then the wallet's setting, then the shared
 * default. A non-positive or non-finite custom rate falls through rather than
 * throwing: Settings can hold a half-typed number, and a send screen should
 * quietly use the default instead of refusing to render.
 */
export function resolveWatchOnlyFeeRate(
  perSendOverride: number | null,
  walletFeeMode: 'auto' | 'custom',
  walletCustomFeeSatPerByte: number
): number | undefined {
  if (
    perSendOverride !== null &&
    Number.isFinite(perSendOverride) &&
    perSendOverride > 0
  ) {
    return perSendOverride;
  }
  if (
    walletFeeMode === 'custom' &&
    Number.isFinite(walletCustomFeeSatPerByte) &&
    walletCustomFeeSatPerByte > 0
  ) {
    return walletCustomFeeSatPerByte;
  }
  return undefined;
}

/** Calculate a fee at an explicit rate without changing the global wallet policy. */
export function feeForTransactionBytes(
  bytes: number,
  feeRateSatPerByte?: number
): bigint {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(
      'Transaction byte size must be a non-negative safe integer.'
    );
  }
  if (feeRateSatPerByte === undefined) return relayFeeForBytes(bytes);
  if (!Number.isFinite(feeRateSatPerByte) || feeRateSatPerByte <= 0) {
    throw new Error('Fee rate must be a positive number of satoshis per byte.');
  }
  const fee = Math.ceil(bytes * feeRateSatPerByte);
  if (!Number.isSafeInteger(fee)) {
    throw new Error('Fee calculation exceeded the safe integer range.');
  }
  return BigInt(fee);
}

export function estimateUnsignedSize(
  inputCount: number,
  outputCount: number
): number {
  return (
    4 +
    1 +
    1 +
    4 +
    inputCount * p2pkhInputBytes() +
    outputCount * p2pkhOutputBytes()
  );
}

function addressToLockingBytecode(address: string): Uint8Array {
  const result = cashAddressToLockingBytecode(address);
  if (typeof result === 'string') {
    throw new Error(`Invalid destination address: ${result}`);
  }
  return Uint8Array.from(result.bytecode);
}

function pathToDerivation(
  accountPath: string,
  branch: 0 | 1,
  index: number
): number[] {
  const match = /^m\/44'\/(\d+)'\/(\d+)'$/.exec(accountPath.trim());
  if (!match) {
    throw new Error(
      "Derivation path must match m/44'/coinType'/accountIndex'."
    );
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
    publicKey: derivations ? new Uint8Array() : hexToBin(input.publicKeyHex),
    masterFingerprint: new Uint8Array(4),
    derivationPath: pathToDerivation(
      accountPath,
      input.branchIndex,
      input.addressIndex
    ),
    redeemScript: input.redeemScriptHex
      ? hexToBin(input.redeemScriptHex)
      : undefined,
    previousTransaction: input.previousTransactionHex
      ? hexToBin(input.previousTransactionHex)
      : undefined,
    token: input.token,
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
  const sighashType = params.sighashType ?? WATCH_ONLY_SIGHASH_TYPE;
  // The master fingerprint is NOT required to produce a signable, valid
  // transaction, and it is not derivable from the account xPub. SeedCash's
  // `sign_psbt_with_xpriv` reads only the *path* out of the 0x06 record
  // (`_, derivation_path = parse_bip32_derivation_value(v)`) and discards the
  // fingerprint. Current SeedCash stores wallet_fingerprint on PSBTParser but
  // does not use it to accept or reject a sign. If a wallet already saved one
  // we stamp it; otherwise zeros. Do not omit the 0x06 record — without a
  // path SeedCash refuses ("xpriv signing requires a PSBT derivation path").
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
  validateTokenPlan(
    params.inputs,
    params.recipientToken,
    params.changeToken,
    params.recipient,
    params.changeAddress,
    params.tokenIntent
  );
  const inputSum = params.inputs.reduce(
    (sum, input) => sum + input.satoshis,
    0n
  );

  // Fee depends on whether a change output survives; iterate to a fixed point
  // (never more than twice in practice).
  let outputs: {
    bytecode: Uint8Array;
    satoshis: bigint;
    isChange: boolean;
    token?: PsbtTokenSpec;
  }[] = [
    {
      bytecode: recipientBytecode,
      satoshis: params.amountSats,
      isChange: false,
      token: params.recipientToken,
    },
  ];
  let changeSats = 0n;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fee = feeForTransactionBytes(
      estimateFinalTransactionBytes(params.inputs, outputs),
      params.feeRateSatPerByte
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
    const withChange: typeof outputs = [
      {
        bytecode: recipientBytecode,
        satoshis: params.amountSats,
        isChange: false,
        token: params.recipientToken,
      },
    ];
    if (nextChange > 0n) {
      withChange.push({
        bytecode: changeBytecode,
        satoshis: nextChange,
        isChange: true,
        token: params.changeToken,
      });
    }
    if (withChange.length === outputs.length && nextChange === changeSats) {
      break;
    }
    outputs = withChange;
    changeSats = nextChange;
  }

  const feeSats = inputSum - params.amountSats - changeSats;
  if ((sighashType & 0x1f) === 0x03 && params.inputs.length > outputs.length) {
    throw new Error(
      'SIGHASH_SINGLE requires a matching output for every input. Add an ' +
        'output or choose All (Recommended).'
    );
  }
  if (params.changeToken && changeSats === 0n) {
    throw new Error(
      'Token change cannot be placed in a zero-satoshi output. Select more BCH or a smaller amount.'
    );
  }
  const psbtInputs: PsbtInputSpec[] = params.inputs.map((input) => ({
    ...inputSpecToPsbt(input, params.accountPath),
    masterFingerprint,
  }));
  const changeOutput: PsbtOutputSpec = {
    lockingBytecode: changeBytecode,
    satoshis: changeSats,
    token: params.changeToken,
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
    output.isChange
      ? changeOutput
      : {
          lockingBytecode: output.bytecode,
          satoshis: output.satoshis,
          token: params.recipientToken,
        }
  );
  const psbtBytes = encodeUnsignedPsbt(
    psbtInputs,
    psbtOutputs,
    sighashType
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
      ...(output.isChange && params.changeToken
        ? { token: psbtTokenToTransactionToken(params.changeToken) }
        : !output.isChange && params.recipientToken
          ? { token: psbtTokenToTransactionToken(params.recipientToken) }
          : {}),
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
      token: output.token,
    })),
    feeSats,
    changeSats,
    inputSumSats: inputSum,
    masterFingerprint: fingerprintKnown ? masterFingerprint : null,
    signerRecognisesInputs: fingerprintKnown,
    sighashType,
  };
}
