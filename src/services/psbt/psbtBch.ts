// BIP174 PSBT for Bitcoin Cash, shaped for air-gapped signers.
//
// Built against the two implementations we actually have to interoperate with,
// not from the BIP alone:
//
//   SeedCash  src/seedcash/models/psbt_parser.py
//   Keystone  @keystonehq/bc-ur-registry-btc (CryptoPSBT)
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

/** Global map keys (BIP174). */
const PSBT_GLOBAL_UNSIGNED_TX = 0x00;

/** Per-input map keys. */
const PSBT_IN_WITNESS_UTXO = 0x01;
const PSBT_IN_PARTIAL_SIG = 0x02;
const PSBT_IN_SIGHASH_TYPE = 0x03;
const PSBT_IN_BIP32_DERIVATION = 0x06;

/** Per-output map keys. */
const PSBT_OUT_BIP32_DERIVATION = 0x02;

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
}

export interface PsbtOutputSpec {
  lockingBytecode: Uint8Array;
  satoshis: bigint;
  /** Present for change, so a signer can recognise the output as its own. */
  publicKey?: Uint8Array;
  masterFingerprint?: Uint8Array;
  derivationPath?: number[];
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
  sighashType: number = SIGHASH_ALL_FORKID_ANYONECANPAY
): Uint8Array {
  if (inputs.length === 0) throw new Error('A PSBT needs at least one input.');
  if (outputs.length === 0) throw new Error('A PSBT needs at least one output.');
  if ((sighashType & SIGHASH_FORKID_BIT) === 0) {
    // Without FORKID the signature is not valid on Bitcoin Cash at all, and the
    // failure would only appear at broadcast, after the user has already walked
    // the transaction through a hardware device.
    throw new Error('BCH sighash types must include SIGHASH_FORKID (0x40).');
  }

  const globalMap = concat([
    record(
      Uint8Array.from([PSBT_GLOBAL_UNSIGNED_TX]),
      unsignedTransaction(inputs, outputs)
    ),
    Uint8Array.from([0x00]),
  ]);

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
      record(
        concat([Uint8Array.from([PSBT_IN_BIP32_DERIVATION]), input.publicKey]),
        bip32DerivationValue(input.masterFingerprint, input.derivationPath)
      ),
      Uint8Array.from([0x00]),
    ]);
  });

  const outputMaps = outputs.map((output) => {
    const fields: Uint8Array[] = [];
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

export interface ParsedPsbt {
  unsignedTransaction: Uint8Array;
  signatures: PsbtSignature[];
  /** Sighash type requested per input, where the field is present. */
  requestedSighashTypes: (number | null)[];
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

/**
 * Parse a PSBT returned by a signer.
 *
 * Only the parts needed to finalize are read. Unknown fields are skipped rather
 * than rejected: a device is free to add its own, and refusing them would break
 * on the next firmware release.
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

  const signatures: PsbtSignature[] = [];
  const requestedSighashTypes: (number | null)[] = [];

  // Input maps come first, then output maps. The unsigned transaction says how
  // many of each, but parsing it is not necessary to collect signatures: read
  // maps until the bytes run out and keep the ones carrying signatures.
  let inputIndex = 0;
  while (!reader.done) {
    const map = readMap(reader);
    let sighashType: number | null = null;
    let sawInputField = false;

    for (const { key, value } of map) {
      if (key[0] === PSBT_IN_PARTIAL_SIG && key.length === 34) {
        sawInputField = true;
        signatures.push({
          inputIndex,
          publicKey: key.subarray(1),
          signature: value,
        });
      } else if (key[0] === PSBT_IN_SIGHASH_TYPE && value.length === 4) {
        sawInputField = true;
        sighashType = new DataView(
          value.buffer,
          value.byteOffset,
          value.byteLength
        ).getUint32(0, true);
      } else if (
        key[0] === PSBT_IN_WITNESS_UTXO ||
        key[0] === PSBT_IN_BIP32_DERIVATION
      ) {
        sawInputField = true;
      }
    }

    if (sawInputField || map.length === 0) {
      requestedSighashTypes.push(sighashType);
      inputIndex += 1;
    }
  }

  return {
    unsignedTransaction: unsigned.value,
    signatures,
    requestedSighashTypes,
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
