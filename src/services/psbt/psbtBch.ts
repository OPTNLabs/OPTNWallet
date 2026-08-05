// BIP174 PSBT for Bitcoin Cash, shaped for air-gapped signers.
//
// Built against the implementations we actually have to interoperate with,
// not from the BIP alone:
//
//   SeedCash  src/seedcash/models/psbt_parser.py
//   Paytaca   src/lib/multisig/psbt.js  (version 145 codec)
//   Keystone  @keystonehq/bc-ur-registry-btc (CryptoPSBT)
//
// Version 145 is what Paytaca's multisig tooling produces: a global version
// field (0xfb), global input/output counts (0x04/0x05) that make section
// boundaries explicit, per-input PREVIOUS_TXID/OUTPUT_INDEX/SEQUENCE
// (0x0e/0x0f/0x10), per-output AMOUNT/SCRIPT (0x03/0x04) and CASHTOKEN (0x36).
// Paytaca throws when those are missing on a v145 PSBT, so they are always
// emitted here. SeedCash skips the unknown globals and parses by the counts.
//
// What SeedCash requires, read off its parser rather than assumed:
//   * the input amount, from PSBT_IN_WITNESS_UTXO (0x01) — it reads
//     `int.from_bytes(v[:8], "little")` — or from a full previous transaction
//     under PSBT_IN_NON_WITNESS_UTXO (0x00). WITNESS_UTXO is used here because
//     it carries the amount in 8 bytes instead of an entire parent transaction,
//     which matters when the result has to fit through animated QR.
//   * PSBT_IN_BIP32_DERIVATION (0x06): key is `0x06 || pubkey`, value is
//     `fingerprint(4) || path` with each level a little-endian uint32. SeedCash
//     decides an input is its own by `v[:4] == wallet_fingerprint_bytes`, so an
//     input without this field is one it will refuse to sign.
//
// BCH has no witness. PSBT_IN_WITNESS_UTXO is used purely as the compact
// "here is the output being spent" carrier, which is how BCH tooling has
// settled on using it — the name is a Bitcoin inheritance, not a claim about
// segwit.

import { encodeTransaction, hexToBin } from '@bitauth/libauth';

export const PSBT_MAGIC = Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff]);

/** PSBT version written to the global map — Paytaca's v145 contract. */
export const PSBT_VERSION_145 = 145;

/** Global map keys (BIP174 + Paytaca v145). */
const PSBT_GLOBAL_UNSIGNED_TX = 0x00;
const PSBT_GLOBAL_XPUB = 0x01;
const PSBT_GLOBAL_INPUT_COUNT = 0x04;
const PSBT_GLOBAL_OUTPUT_COUNT = 0x05;
const PSBT_GLOBAL_VERSION = 0xfb;

/** Per-input map keys. */
const PSBT_IN_WITNESS_UTXO = 0x01;
const PSBT_IN_PARTIAL_SIG = 0x02;
const PSBT_IN_SIGHASH_TYPE = 0x03;
const PSBT_IN_REDEEM_SCRIPT = 0x04;
const PSBT_IN_BIP32_DERIVATION = 0x06;
const PSBT_IN_PREVIOUS_TXID = 0x0e;
const PSBT_IN_OUTPUT_INDEX = 0x0f;
const PSBT_IN_SEQUENCE = 0x10;

/** Per-output map keys. */
const PSBT_OUT_REDEEM_SCRIPT = 0x00;
const PSBT_OUT_BIP32_DERIVATION = 0x02;
const PSBT_OUT_AMOUNT = 0x03;
const PSBT_OUT_SCRIPT = 0x04;
const PSBT_OUT_CASHTOKEN = 0x36;

/**
 * SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_ANYONECANPAY.
 *
 * Mandated by the watch-only specification. FORKID (0x40) is what makes a
 * signature valid on BCH at all; ANYONECANPAY (0x80) commits to this input
 * only, so signers can be handed inputs independently.
 */
export const SIGHASH_ALL_FORKID_ANYONECANPAY = 0xc1;

/** SIGHASH_ALL | SIGHASH_FORKID — what a BCH signer does by default. */
export const SIGHASH_ALL_FORKID = 0x41;

const SIGHASH_FORKID_BIT = 0x40;

export interface PsbtInputSpec {
  /** Previous transaction id in DISPLAY order, as shown by explorers. */
  txid: string;
  vout: number;
  satoshis: bigint;
  /** Locking script of the output being spent. */
  lockingBytecode: Uint8Array;
  /** Compressed public key (33 bytes) that must sign this input. */
  publicKey: Uint8Array;
  /** Master key fingerprint (4 bytes) — how a signer claims the input. */
  masterFingerprint: Uint8Array;
  /** Full BIP32 path, hardened levels already OR-ed with 0x80000000. */
  derivationPath: number[];
  sequence?: number;
  /** Redeem script for p2sh inputs; the signer needs it to build the unlock. */
  redeemScript?: Uint8Array;
  /**
   * Signatures already collected for this input (e.g. from a returned
   * partially-signed PSBT being merged). Emitted as PSBT_IN_PARTIAL_SIG.
   */
  partialSignatures?: PsbtSignature[];
}

export interface PsbtTokenSpec {
  /** Token category id, 32 bytes. */
  category: Uint8Array;
  /** Fungible token amount (8-byte little-endian). */
  amount?: bigint;
  /** NFT capability: 0 = none, 1 = mutable, 2 = minting. */
  capability?: number;
  /** NFT commitment bytes. */
  commitment?: Uint8Array;
}

export interface PsbtOutputSpec {
  lockingBytecode: Uint8Array;
  satoshis: bigint;
  /** Present for change, so a signer can recognise the output as its own. */
  publicKey?: Uint8Array;
  masterFingerprint?: Uint8Array;
  derivationPath?: number[];
  redeemScript?: Uint8Array;
  /** CashToken carried by this output, encoded as a v145 token prefix. */
  token?: PsbtTokenSpec;
}

/**
 * An extended public key to publish in the global map, so a signer can
 * recognise wallet addresses without an entry per key. Paytaca encodes the
 * value as `master fingerprint(4) || uint32LE path levels`.
 */
export interface PsbtGlobalXpubSpec {
  /** The 78-byte serialized xpub payload (what base58 decodes to). */
  xpubPayload: Uint8Array;
  masterFingerprint: Uint8Array;
  /** Full BIP32 path from the master key, hardened levels OR-ed 0x80000000. */
  derivationPath: number[];
}

export interface PsbtEncodeOptions {
  globalXpubs?: PsbtGlobalXpubSpec[];
}

function varInt(value: number): Uint8Array {
  if (value < 0xfd) return Uint8Array.from([value]);
  if (value <= 0xffff) return Uint8Array.from([0xfd, value & 0xff, value >> 8]);
  if (value <= 0xffffffff) {
    return Uint8Array.from([
      0xfe,
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    ]);
  }
  throw new Error('varint too large for a PSBT field');
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32LE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function uint64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function readUint32LE(bytes: Uint8Array): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint32(0, true);
}

function readUint64LE(bytes: Uint8Array): bigint {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getBigUint64(0, true);
}

/**
 * CHIP-2022-02 token prefix, as written by Paytaca's `encodeTokenPrefix`:
 * fungible tokens are `category(32) || 0x00 || amount(8 LE)`, NFTs are
 * `category(32) || (0x80 | capability) || compactUint(length) || commitment`.
 */
function encodeTokenPrefix(token: PsbtTokenSpec): Uint8Array {
  if (token.category.length !== 32) {
    throw new Error('Token category must be 32 bytes.');
  }
  if (token.amount !== undefined && token.amount !== null) {
    if (token.amount < 0n) throw new Error('Token amounts cannot be negative.');
    return concat([token.category, Uint8Array.from([0x00]), uint64LE(token.amount)]);
  }
  const capability = token.capability ?? 0;
  if (!Number.isInteger(capability) || capability < 0 || capability > 2) {
    throw new Error('NFT capability must be 0 (none), 1 (mutable), or 2 (minting).');
  }
  const commitment = token.commitment ?? Uint8Array.of();
  return concat([
    token.category,
    Uint8Array.from([0x80 | capability]),
    varInt(commitment.length),
    commitment,
  ]);
}

function decodeTokenPrefix(bytes: Uint8Array): PsbtTokenSpec {
  if (bytes.length < 33) throw new Error('Token prefix is too short.');
  const category = bytes.subarray(0, 32);
  const marker = bytes[32];
  if (marker === 0x00) {
    if (bytes.length !== 41) throw new Error('FT token prefix must be 41 bytes.');
    return { category, amount: readUint64LE(bytes.subarray(33, 41)) };
  }
  if ((marker & 0x80) === 0 || (marker & 0x7f) > 2) {
    throw new Error('Token prefix has an invalid capability byte.');
  }
  const commitmentReader = new Reader(bytes.subarray(33));
  const length = commitmentReader.varInt();
  const commitment = commitmentReader.take(length);
  if (!commitmentReader.done) throw new Error('Token prefix has trailing bytes.');
  return { category, capability: marker & 0x7f, commitment };
}

/** One `<keylen><key><valuelen><value>` record. */
function record(key: Uint8Array, value: Uint8Array): Uint8Array {
  return concat([varInt(key.length), key, varInt(value.length), value]);
}

function bip32DerivationValue(
  masterFingerprint: Uint8Array,
  path: number[]
): Uint8Array {
  if (masterFingerprint.length !== 4) {
    throw new Error('Master fingerprint must be 4 bytes.');
  }
  return concat([masterFingerprint, ...path.map((level) => uint32LE(level))]);
}

/**
 * The transaction a signer is being asked to authorise, with empty unlocking
 * scripts — BIP174 requires the global unsigned transaction to carry none.
 */
function unsignedTransaction(
  inputs: PsbtInputSpec[],
  outputs: PsbtOutputSpec[]
): Uint8Array {
  return encodeTransaction({
    version: 2,
    inputs: inputs.map((input) => ({
      // libauth takes the txid in DISPLAY order here and performs the
      // little-endian reversal inside encodeTransaction. Reversing it here as
      // well is the bug that produced "Missing inputs" on a broadcast where
      // every signature was individually valid.
      outpointTransactionHash: hexToBin(input.txid),
      outpointIndex: input.vout,
      unlockingBytecode: Uint8Array.of(),
      sequenceNumber: input.sequence ?? 0xffffffff,
    })),
    outputs: outputs.map((output) => ({
      lockingBytecode: output.lockingBytecode,
      valueSatoshis: output.satoshis,
    })),
    locktime: 0,
  });
}

/**
 * Encode an unsigned PSBT for an air-gapped signer.
 *
 * `sighashType` is written into every input as PSBT_IN_SIGHASH_TYPE so the
 * signer is told which commitment to make, rather than being left to guess.
 */
export function encodeUnsignedPsbt(
  inputs: PsbtInputSpec[],
  outputs: PsbtOutputSpec[],
  sighashType: number = SIGHASH_ALL_FORKID_ANYONECANPAY,
  options: PsbtEncodeOptions = {}
): Uint8Array {
  if (inputs.length === 0) throw new Error('A PSBT needs at least one input.');
  if (outputs.length === 0) throw new Error('A PSBT needs at least one output.');
  if ((sighashType & SIGHASH_FORKID_BIT) === 0) {
    // Without FORKID the signature is not valid on Bitcoin Cash at all, and the
    // failure would only appear at broadcast, after the user has already walked
    // the transaction through a hardware device.
    throw new Error('BCH sighash types must include SIGHASH_FORKID (0x40).');
  }

  const globalFields: Uint8Array[] = [
    record(
      Uint8Array.from([PSBT_GLOBAL_UNSIGNED_TX]),
      unsignedTransaction(inputs, outputs)
    ),
    // Paytaca's v145 reader requires this field; SeedCash skips it.
    record(Uint8Array.from([PSBT_GLOBAL_VERSION]), varInt(PSBT_VERSION_145)),
  ];
  for (const xpub of options.globalXpubs ?? []) {
    if (xpub.xpubPayload.length !== 78) {
      throw new Error('Global xpub payloads must be 78 bytes.');
    }
    globalFields.push(
      record(
        concat([Uint8Array.from([PSBT_GLOBAL_XPUB]), xpub.xpubPayload]),
        bip32DerivationValue(xpub.masterFingerprint, xpub.derivationPath)
      )
    );
  }
  // Explicit counts make section boundaries unambiguous; SeedCash parses by
  // them when they are present.
  globalFields.push(
    record(Uint8Array.from([PSBT_GLOBAL_INPUT_COUNT]), varInt(inputs.length)),
    record(Uint8Array.from([PSBT_GLOBAL_OUTPUT_COUNT]), varInt(outputs.length))
  );
  const globalMap = concat([...globalFields, Uint8Array.from([0x00])]);

  const inputMaps = inputs.map((input) => {
    if (input.publicKey.length !== 33) {
      throw new Error('Input public keys must be compressed (33 bytes).');
    }
    return concat([
      // Amount + locking script of the output being spent. The amount is not
      // optional on BCH: FORKID signatures commit to it.
      record(
        Uint8Array.from([PSBT_IN_WITNESS_UTXO]),
        concat([
          uint64LE(input.satoshis),
          varInt(input.lockingBytecode.length),
          input.lockingBytecode,
        ])
      ),
      record(Uint8Array.from([PSBT_IN_SIGHASH_TYPE]), uint32LE(sighashType)),
      ...(input.redeemScript
        ? [record(Uint8Array.from([PSBT_IN_REDEEM_SCRIPT]), input.redeemScript)]
        : []),
      ...(input.partialSignatures ?? []).map((signature) =>
        record(
          concat([Uint8Array.from([PSBT_IN_PARTIAL_SIG]), signature.publicKey]),
          signature.signature
        )
      ),
      record(
        concat([Uint8Array.from([PSBT_IN_BIP32_DERIVATION]), input.publicKey]),
        bip32DerivationValue(input.masterFingerprint, input.derivationPath)
      ),
      // v145 fields: the outpoint and sequence, for signers that read them
      // instead of the embedded unsigned transaction.
      record(Uint8Array.from([PSBT_IN_PREVIOUS_TXID]), hexToBin(input.txid)),
      record(Uint8Array.from([PSBT_IN_OUTPUT_INDEX]), uint32LE(input.vout)),
      record(
        Uint8Array.from([PSBT_IN_SEQUENCE]),
        uint32LE(input.sequence ?? 0xffffffff)
      ),
      Uint8Array.from([0x00]),
    ]);
  });

  const outputMaps = outputs.map((output) => {
    const fields: Uint8Array[] = [];
    if (output.redeemScript) {
      fields.push(record(Uint8Array.from([PSBT_OUT_REDEEM_SCRIPT]), output.redeemScript));
    }
    if (output.publicKey && output.masterFingerprint && output.derivationPath) {
      // Lets the signing device show "change" instead of treating the wallet's
      // own address as an unknown third party.
      fields.push(
        record(
          concat([
            Uint8Array.from([PSBT_OUT_BIP32_DERIVATION]),
            output.publicKey,
          ]),
          bip32DerivationValue(output.masterFingerprint, output.derivationPath)
        )
      );
    }
    fields.push(record(Uint8Array.from([PSBT_OUT_AMOUNT]), uint64LE(output.satoshis)));
    fields.push(record(Uint8Array.from([PSBT_OUT_SCRIPT]), output.lockingBytecode));
    if (output.token) {
      fields.push(
        record(Uint8Array.from([PSBT_OUT_CASHTOKEN]), encodeTokenPrefix(output.token))
      );
    }
    fields.push(Uint8Array.from([0x00]));
    return concat(fields);
  });

  return concat([PSBT_MAGIC, globalMap, ...inputMaps, ...outputMaps]);
}

export interface PsbtSignature {
  inputIndex: number;
  publicKey: Uint8Array;
  /** DER or Schnorr signature WITH its trailing sighash byte. */
  signature: Uint8Array;
}

export interface ParsedPsbtDerivation {
  publicKey: Uint8Array;
  masterFingerprint: Uint8Array;
  derivationPath: number[];
}

export interface ParsedPsbtInput {
  /** Previous txid in display order (the PSBT stores it that way). */
  previousTxid: Uint8Array | null;
  outpointIndex: number | null;
  sequence: number | null;
  /** Value of the output being spent, where PSBT_IN_WITNESS_UTXO is present. */
  spentSatoshis: bigint | null;
  redeemScript: Uint8Array | null;
  requestedSighashType: number | null;
  partialSignatures: PsbtSignature[];
  /** BIP32 derivations: which keys the signer is expected to use. */
  derivations: ParsedPsbtDerivation[];
}

export interface ParsedPsbtOutput {
  satoshis: bigint | null;
  lockingBytecode: Uint8Array | null;
  redeemScript: Uint8Array | null;
  token: PsbtTokenSpec | null;
  derivations: ParsedPsbtDerivation[];
}

export interface ParsedPsbtGlobalXpub {
  xpubPayload: Uint8Array;
  masterFingerprint: Uint8Array;
  derivationPath: number[];
}

export interface ParsedPsbt {
  unsignedTransaction: Uint8Array;
  signatures: PsbtSignature[];
  /** Sighash type requested per input, where the field is present. */
  requestedSighashTypes: (number | null)[];
  /** Global version field (0xfb) — Paytaca v145 PSBTs carry 145. */
  version: number | null;
  /** Section counts from the global map (0x04/0x05), where present. */
  inputCount: number | null;
  outputCount: number | null;
  globalXpubs: ParsedPsbtGlobalXpub[];
  inputs: ParsedPsbtInput[];
  outputs: ParsedPsbtOutput[];
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new Error('PSBT ended in the middle of a field.');
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  varInt(): number {
    const first = this.take(1)[0];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const b = this.take(2);
      return b[0] | (b[1] << 8);
    }
    if (first === 0xfe) {
      const b = this.take(4);
      return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    }
    throw new Error('PSBT field length exceeds what this wallet will parse.');
  }
}

function readMap(reader: Reader): { key: Uint8Array; value: Uint8Array }[] {
  const entries: { key: Uint8Array; value: Uint8Array }[] = [];
  for (;;) {
    if (reader.done) throw new Error('PSBT map was not terminated.');
    const keyLength = reader.varInt();
    if (keyLength === 0) return entries;
    const key = reader.take(keyLength);
    const value = reader.take(reader.varInt());
    entries.push({ key, value });
  }
}

function decodeBip32Value(
  value: Uint8Array
): { masterFingerprint: Uint8Array; derivationPath: number[] } | null {
  if (value.length < 4 || (value.length - 4) % 4 !== 0) return null;
  const masterFingerprint = value.subarray(0, 4);
  const derivationPath: number[] = [];
  for (let i = 4; i < value.length; i += 4) {
    derivationPath.push(readUint32LE(value.subarray(i, i + 4)));
  }
  return { masterFingerprint, derivationPath };
}

function parseInputMap(
  map: { key: Uint8Array; value: Uint8Array }[],
  inputIndex: number
): ParsedPsbtInput {
  const parsed: ParsedPsbtInput = {
    previousTxid: null,
    outpointIndex: null,
    sequence: null,
    spentSatoshis: null,
    redeemScript: null,
    requestedSighashType: null,
    partialSignatures: [],
    derivations: [],
  };
  for (const { key, value } of map) {
    switch (key[0]) {
      case PSBT_IN_WITNESS_UTXO:
        if (value.length >= 8) parsed.spentSatoshis = readUint64LE(value.subarray(0, 8));
        break;
      case PSBT_IN_PARTIAL_SIG:
        if (key.length === 34) {
          parsed.partialSignatures.push({
            inputIndex,
            publicKey: key.subarray(1),
            signature: value,
          });
        }
        break;
      case PSBT_IN_BIP32_DERIVATION: {
        const decoded = decodeBip32Value(value);
        if (decoded) {
          parsed.derivations.push({ publicKey: key.subarray(1), ...decoded });
        }
        break;
      }
      case PSBT_IN_SIGHASH_TYPE:
        if (value.length === 4) parsed.requestedSighashType = readUint32LE(value);
        break;
      case PSBT_IN_REDEEM_SCRIPT:
        parsed.redeemScript = value;
        break;
      case PSBT_IN_PREVIOUS_TXID:
        parsed.previousTxid = value;
        break;
      case PSBT_IN_OUTPUT_INDEX:
        if (value.length === 4) parsed.outpointIndex = readUint32LE(value);
        break;
      case PSBT_IN_SEQUENCE:
        if (value.length === 4) parsed.sequence = readUint32LE(value);
        break;
      default:
        // PSBT_IN_NON_WITNESS_UTXO (0x00) and anything else is not needed here:
        // the amount already comes from WITNESS_UTXO.
        break;
    }
  }
  return parsed;
}

function parseOutputMap(
  map: { key: Uint8Array; value: Uint8Array }[]
): ParsedPsbtOutput {
  const parsed: ParsedPsbtOutput = {
    satoshis: null,
    lockingBytecode: null,
    redeemScript: null,
    token: null,
    derivations: [],
  };
  for (const { key, value } of map) {
    switch (key[0]) {
      case PSBT_OUT_REDEEM_SCRIPT:
        parsed.redeemScript = value;
        break;
      case PSBT_OUT_BIP32_DERIVATION: {
        const decoded = decodeBip32Value(value);
        if (decoded) parsed.derivations.push({ publicKey: key.subarray(1), ...decoded });
        break;
      }
      case PSBT_OUT_AMOUNT:
        if (value.length === 8) parsed.satoshis = readUint64LE(value);
        break;
      case PSBT_OUT_SCRIPT:
        parsed.lockingBytecode = value;
        break;
      case PSBT_OUT_CASHTOKEN:
        parsed.token = decodeTokenPrefix(value);
        break;
      default:
        break;
    }
  }
  return parsed;
}

/**
 * Parse a PSBT returned by a signer, or one built for signing.
 *
 * When the global map carries explicit section counts (Paytaca v145) the maps
 * are read exactly by count. Otherwise the older v0 layout is parsed with the
 * same heuristic as before. Unknown fields are skipped rather than rejected: a
 * device is free to add its own, and refusing them would break on the next
 * firmware release.
 */
export function decodePsbt(bytes: Uint8Array): ParsedPsbt {
  if (bytes.length < PSBT_MAGIC.length) throw new Error('Not a PSBT.');
  for (let i = 0; i < PSBT_MAGIC.length; i += 1) {
    if (bytes[i] !== PSBT_MAGIC[i]) throw new Error('Not a PSBT.');
  }

  const reader = new Reader(bytes.subarray(PSBT_MAGIC.length));
  const global = readMap(reader);
  const unsigned = global.find((e) => e.key[0] === PSBT_GLOBAL_UNSIGNED_TX);
  if (!unsigned) throw new Error('PSBT has no unsigned transaction.');

  let version: number | null = null;
  let inputCount: number | null = null;
  let outputCount: number | null = null;
  const globalXpubs: ParsedPsbtGlobalXpub[] = [];
  for (const { key, value } of global) {
    if (key.length === 1 && key[0] === PSBT_GLOBAL_VERSION) {
      version = new Reader(value).varInt();
    } else if (key.length === 1 && key[0] === PSBT_GLOBAL_INPUT_COUNT) {
      inputCount = new Reader(value).varInt();
    } else if (key.length === 1 && key[0] === PSBT_GLOBAL_OUTPUT_COUNT) {
      outputCount = new Reader(value).varInt();
    } else if (key[0] === PSBT_GLOBAL_XPUB && key.length === 79) {
      const decoded = decodeBip32Value(value);
      if (decoded) globalXpubs.push({ xpubPayload: key.subarray(1), ...decoded });
    }
  }

  const inputs: ParsedPsbtInput[] = [];
  const outputs: ParsedPsbtOutput[] = [];

  if (inputCount !== null && outputCount !== null) {
    for (let i = 0; i < inputCount; i += 1) {
      if (reader.done) throw new Error('PSBT input count does not match its maps.');
      inputs.push(parseInputMap(readMap(reader), i));
    }
    for (let o = 0; o < outputCount; o += 1) {
      if (reader.done) throw new Error('PSBT output count does not match its maps.');
      outputs.push(parseOutputMap(readMap(reader)));
    }
    if (!reader.done) {
      throw new Error('PSBT contains more maps than its counts allow.');
    }
  } else {
    // No counts: a v0 PSBT. Input maps come first, then output maps; classify
    // each map by the fields it carries.
    let inputIndex = 0;
    while (!reader.done) {
      const map = readMap(reader);
      const parsedInput = parseInputMap(map, inputIndex);
      const sawInputField =
        parsedInput.requestedSighashType !== null ||
        parsedInput.spentSatoshis !== null ||
        parsedInput.partialSignatures.length > 0 ||
        parsedInput.redeemScript !== null ||
        parsedInput.previousTxid !== null ||
        map.some(({ key }) => key[0] === PSBT_IN_BIP32_DERIVATION);
      if (sawInputField || map.length === 0) {
        inputs.push(parsedInput);
        inputIndex += 1;
      } else {
        outputs.push(parseOutputMap(map));
      }
    }
  }

  const signatures = inputs.flatMap((input, inputIndex) =>
    input.partialSignatures.map((signature) => ({ ...signature, inputIndex }))
  );
  const requestedSighashTypes = inputs.map((input) => input.requestedSighashType);

  return {
    unsignedTransaction: unsigned.value,
    signatures,
    requestedSighashTypes,
    version,
    inputCount,
    outputCount,
    globalXpubs,
    inputs,
    outputs,
  };
}

/** The sighash byte a signature actually committed to. */
export function sighashTypeOf(signature: Uint8Array): number | null {
  return signature.length === 0 ? null : signature[signature.length - 1];
}

/**
 * Reject signatures that did not commit to what we asked for.
 *
 * A device that ignores PSBT_IN_SIGHASH_TYPE and signs with its own default
 * produces a signature that is perfectly well-formed and simply does not
 * validate — the transaction is rejected at broadcast, long after the user has
 * finished with the device and has no idea which step was wrong. SeedCash does
 * exactly this today: it hard-codes 0x41 and never reads the field.
 */
export function verifySignatureSighashTypes(
  signatures: PsbtSignature[],
  expected: number
): { ok: true } | { ok: false; message: string } {
  for (const sig of signatures) {
    const actual = sighashTypeOf(sig.signature);
    if (actual === null) {
      return {
        ok: false,
        message: `Input ${sig.inputIndex} came back with an empty signature.`,
      };
    }
    if (actual !== expected) {
      return {
        ok: false,
        message:
          `Input ${sig.inputIndex} was signed with sighash 0x${actual.toString(16)}, ` +
          `but this transaction requires 0x${expected.toString(16)}. The signing ` +
          `device ignored the requested sighash type, so the signature cannot be ` +
          `used. Broadcasting it would fail.`,
      };
    }
  }
  return { ok: true };
}
