// Per-install MLS device slot (MIP-06 intent: one leaf per device, same npub).
// Extra devices use RFC 9420 Add, not the unfinalized External Commit draft:
// https://github.com/marmot-protocol/marmot/blob/master/features/multi-device.md

import { bytesToHex } from '@noble/hashes/utils';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import {
  decode,
  encode,
  getGroupMembers,
  mlsMessageDecoder,
  mlsMessageEncoder,
  privateKeyPackageDecoder,
  privateKeyPackageEncoder,
  protocolVersions,
  wireformats,
  type ClientState,
  type KeyPackage,
  type PrivateKeyPackage,
} from 'ts-mls';
import { credentialPubkeyHex } from './mlsIdentityProof';

const DEVICE_KEY = (pubkey: string) => `nostr-mls-device:${pubkey}`;
const KP_KEY = (pubkey: string, deviceIndex: number) =>
  `nostr-mls-kp:${pubkey}:${deviceIndex}`;

const deviceSlots = new Map<string, number>();
const kpMemory = new Map<
  string,
  { publicPackage: KeyPackage; privatePackage: PrivateKeyPackage }
>();

function kpMemKey(pubkey: string, deviceIndex: number) {
  return `${pubkey}:${deviceIndex}`;
}

export async function loadMlsDeviceIndex(pubkey: string): Promise<number> {
  const mem = deviceSlots.get(pubkey);
  if (typeof mem === 'number') return mem;
  try {
    const stored = await idbGet(DEVICE_KEY(pubkey));
    if (typeof stored === 'number' && stored >= 0) {
      deviceSlots.set(pubkey, stored);
      return stored;
    }
  } catch {
    /* tests / private mode */
  }
  return 0;
}

export async function saveMlsDeviceIndex(
  pubkey: string,
  deviceIndex: number
): Promise<void> {
  if (!Number.isInteger(deviceIndex) || deviceIndex < 0) {
    throw new Error('device index must be a non-negative integer');
  }
  deviceSlots.set(pubkey, deviceIndex);
  try {
    await idbSet(DEVICE_KEY(pubkey), deviceIndex);
  } catch {
    /* best-effort */
  }
}

/** First extra install on this seed. Slot 0 stays the primary device. */
export async function claimExtraMlsDeviceSlot(pubkey: string): Promise<number> {
  const current = await loadMlsDeviceIndex(pubkey);
  if (current > 0) return current;
  await saveMlsDeviceIndex(pubkey, 1);
  return 1;
}

function wrapKeyPackage(keyPackage: KeyPackage) {
  return {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_key_package,
    keyPackage,
  };
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(str: string): Uint8Array {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function saveMlsKeyPackage(
  pubkey: string,
  deviceIndex: number,
  publicPackage: KeyPackage,
  privatePackage: PrivateKeyPackage
): Promise<void> {
  kpMemory.set(kpMemKey(pubkey, deviceIndex), { publicPackage, privatePackage });
  try {
    await idbSet(KP_KEY(pubkey, deviceIndex), {
      publicB64: bytesToB64(encode(mlsMessageEncoder, wrapKeyPackage(publicPackage))),
      privateB64: bytesToB64(encode(privateKeyPackageEncoder, privatePackage)),
    });
  } catch {
    /* best-effort */
  }
}

export async function loadMlsKeyPackage(
  pubkey: string,
  deviceIndex: number
): Promise<{ publicPackage: KeyPackage; privatePackage: PrivateKeyPackage } | null> {
  const mem = kpMemory.get(kpMemKey(pubkey, deviceIndex));
  if (mem) return mem;
  try {
    const stored = await idbGet(KP_KEY(pubkey, deviceIndex));
    if (!stored || typeof stored !== 'object') return null;
    const { publicB64, privateB64 } = stored as {
      publicB64?: string;
      privateB64?: string;
    };
    if (typeof publicB64 !== 'string' || typeof privateB64 !== 'string') return null;
    const msg = decode(mlsMessageDecoder, b64ToBytes(publicB64));
    const privatePackage = decode(privateKeyPackageDecoder, b64ToBytes(privateB64));
    if (!msg || msg.wireformat !== wireformats.mls_key_package || !privatePackage) {
      return null;
    }
    const packed = { publicPackage: msg.keyPackage, privatePackage };
    kpMemory.set(kpMemKey(pubkey, deviceIndex), packed);
    return packed;
  } catch {
    return null;
  }
}

export function coalescedMemberPubKeys(state: ClientState): string[] {
  const pubkeys = new Set<string>();
  for (const leaf of getGroupMembers(state)) {
    const pk = credentialPubkeyHex(leaf.credential);
    if (pk) pubkeys.add(pk);
  }
  return [...pubkeys];
}

export function mlsLeafCount(state: ClientState): number {
  return getGroupMembers(state).length;
}

export function leafCountForPubkey(state: ClientState, pubkey: string): number {
  let n = 0;
  for (const leaf of getGroupMembers(state)) {
    if (credentialPubkeyHex(leaf.credential) === pubkey) n += 1;
  }
  return n;
}

export function leafHasSignatureKey(
  state: ClientState,
  signaturePublicKey: Uint8Array
): boolean {
  const want = bytesToHex(signaturePublicKey);
  for (const leaf of getGroupMembers(state)) {
    if (bytesToHex(leaf.signaturePublicKey) === want) return true;
  }
  return false;
}
