/**
 * P2P CashFusion v4 — Electron Cash component plane.
 *
 * Blind credentials cover `sha256(serialized Component)` exactly as the
 * classic server path (`src-tauri/src/fusion/components.rs` /
 * `p2p_component.rs`). Unlinkability remains transport-only (throwaway + Tor).
 *
 * Spec: docs/p2p-ec-component-plane-v4.md
 */
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';

export const P2P_COMPONENT_PROTOCOL = 'p2p-v4-ec-component' as const;

/** Live wire version once this module is used for all credential messages. */
export const ROUND_MSG_VERSION_V4 = 4 as const;

/**
 * Electron Cash protobuf wire vector for one Input Component
 * (salt_commitment=0x11*32, prev_txid wire=0xaa*32, index=3, pubkey=0x02*33, amount=200000).
 */
export const EC_INPUT_COMPONENT_GOLDEN_HEX =
  '0a20' +
  '1111111111111111111111111111111111111111111111111111111111111111' +
  '124b0a20' +
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
  '10031a21' +
  '020202020202020202020202020202020202020202020202020202020202020202' +
  '20c09a0c';

function writeVarint(n: number): number[] {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error('varint out of range');
  }
  const out: number[] = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function writeVarintBig(n: bigint): number[] {
  if (n < 0n) throw new Error('varint negative');
  const out: number[] = [];
  let v = n;
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

function tag(field: number, wireType: number): number[] {
  return writeVarint((field << 3) | wireType);
}

function lenDelim(field: number, bytes: Uint8Array): number[] {
  return [...tag(field, 2), ...writeVarint(bytes.length), ...bytes];
}

function displayTxidToWire(prevTxidDisplayHex: string): Uint8Array {
  const display = hexToBin(prevTxidDisplayHex.toLowerCase());
  if (display.length !== 32) {
    throw new Error('prevTxid must be 32 bytes');
  }
  return display.slice().reverse();
}

/** sha256(salt) as 32-byte salt_commitment (EC). */
export function saltCommitmentFromSalt(salt: Uint8Array): Uint8Array {
  if (salt.length !== 32) throw new Error('salt must be 32 bytes');
  return new Uint8Array(sha256.hash(salt));
}

export function randomSalt32(): Uint8Array {
  const salt = new Uint8Array(32);
  globalThis.crypto.getRandomValues(salt);
  return salt;
}

/** EC InitialCommitment hash: sha256(salt || canonical Component bytes). */
export function saltedComponentHashHex(
  saltHex: string,
  componentBytes: Uint8Array
): string {
  const salt = hexToBin(saltHex.toLowerCase());
  if (salt.length !== 32) throw new Error('salt must be 32 bytes');
  if (componentBytes.length === 0 || componentBytes.length > 200 * 1024) {
    throw new Error('component bytes length is invalid');
  }
  const payload = new Uint8Array(salt.length + componentBytes.length);
  payload.set(salt);
  payload.set(componentBytes, salt.length);
  return binToHex(sha256.hash(payload));
}

/**
 * Encode a finalized Input Component (protobuf2, fusion.proto field layout).
 * `prevTxidDisplayHex` is explorer/big-endian; stored wire-order little-endian.
 */
export function encodeInputComponent(args: {
  prevTxidDisplayHex: string;
  prevIndex: number;
  pubkeyHex: string;
  amount: number;
  saltCommitmentHex: string;
}): Uint8Array {
  const saltCommitment = hexToBin(args.saltCommitmentHex.toLowerCase());
  if (saltCommitment.length !== 32) {
    throw new Error('saltCommitment must be 32 bytes');
  }
  const pubkey = hexToBin(args.pubkeyHex.toLowerCase());
  if (pubkey.length < 1 || pubkey.length > 65) {
    throw new Error('pubkey length out of range');
  }
  if (!Number.isSafeInteger(args.prevIndex) || args.prevIndex < 0) {
    throw new Error('prevIndex invalid');
  }
  if (!Number.isSafeInteger(args.amount) || args.amount < 0) {
    throw new Error('amount invalid');
  }
  const prevWire = displayTxidToWire(args.prevTxidDisplayHex);
  const inputBody = new Uint8Array([
    ...lenDelim(1, prevWire),
    ...tag(2, 0),
    ...writeVarint(args.prevIndex),
    ...lenDelim(3, pubkey),
    ...tag(4, 0),
    ...writeVarintBig(BigInt(args.amount)),
  ]);
  return new Uint8Array([
    ...lenDelim(1, saltCommitment),
    ...lenDelim(2, inputBody),
  ]);
}

/** Encode a finalized Output Component. */
export function encodeOutputComponent(args: {
  scriptHex: string;
  amount: number;
  saltCommitmentHex: string;
}): Uint8Array {
  const saltCommitment = hexToBin(args.saltCommitmentHex.toLowerCase());
  if (saltCommitment.length !== 32) {
    throw new Error('saltCommitment must be 32 bytes');
  }
  const script = hexToBin(args.scriptHex.toLowerCase());
  if (script.length < 1 || script.length > 10_000) {
    throw new Error('script length out of range');
  }
  if (!Number.isSafeInteger(args.amount) || args.amount < 0) {
    throw new Error('amount invalid');
  }
  const outputBody = new Uint8Array([
    ...lenDelim(1, script),
    ...tag(2, 0),
    ...writeVarintBig(BigInt(args.amount)),
  ]);
  return new Uint8Array([
    ...lenDelim(1, saltCommitment),
    ...lenDelim(3, outputBody), // field 3 = output oneof
  ]);
}

/** Blind-credential message: SHA-256 over raw component bytes (EC rule). */
export function componentBlindMessageHash(
  componentBytes: Uint8Array
): Uint8Array {
  if (componentBytes.length === 0) {
    throw new Error('component bytes must be non-empty');
  }
  if (componentBytes.length > 200 * 1024) {
    throw new Error('component bytes exceed fusion max message size');
  }
  return new Uint8Array(sha256.hash(componentBytes));
}

export function componentBlindMessageHashHex(componentHex: string): string {
  return binToHex(componentBlindMessageHash(hexToBin(componentHex)));
}

export function inputComponentBlindMessage(args: {
  prevTxidDisplayHex: string;
  prevIndex: number;
  pubkeyHex: string;
  amount: number;
  saltCommitmentHex: string;
}): Uint8Array {
  return componentBlindMessageHash(encodeInputComponent(args));
}

export function outputComponentBlindMessage(args: {
  scriptHex: string;
  amount: number;
  saltCommitmentHex: string;
}): Uint8Array {
  return componentBlindMessageHash(encodeOutputComponent(args));
}

/** Fresh salt + commitment pair for one component. */
export function freshSaltCommitment(): {
  saltHex: string;
  saltCommitmentHex: string;
} {
  const salt = randomSalt32();
  return {
    saltHex: binToHex(salt),
    saltCommitmentHex: binToHex(saltCommitmentFromSalt(salt)),
  };
}
