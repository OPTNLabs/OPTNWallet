// marmot.account-identity-proof.v1 LeafNode extension (0xF2F1).
// Wire matches marmot-ts / darkmatter: BIP-340 over SHA-256(canonical message).
// https://github.com/marmot-protocol/marmot-ts/blob/master/src/core/account-identity-proof.ts

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import {
  defaultCredentialTypes,
  makeCustomExtension,
  type Credential,
  type CredentialBasic,
  type CustomExtension,
  type LeafNode,
} from 'ts-mls';

export const ACCOUNT_IDENTITY_PROOF_EXT = 0xf2f1;
const ACCOUNT_IDENTITY_PROOF_VERSION = 1;
const ACCOUNT_IDENTITY_PROOF_DOMAIN = 'marmot.account-identity-proof.v1';
const ACCOUNT_IDENTITY_LEN = 32;
const SCHNORR_SIGNATURE_LEN = 64;

const MLS_SIGNATURE_SCHEME_BY_CIPHERSUITE: Record<number, number> = {
  1: 0x0807,
  2: 0x0403,
  3: 0x0807,
  4: 0x0808,
  5: 0x0603,
  6: 0x0808,
  7: 0x0503,
};

export function mlsSignatureScheme(ciphersuite: number): number {
  const scheme = MLS_SIGNATURE_SCHEME_BY_CIPHERSUITE[ciphersuite];
  if (scheme === undefined) {
    throw new Error(
      `Unknown MLS signature scheme for ciphersuite ${ciphersuite}`
    );
  }
  return scheme;
}

export type AccountIdentityProofRequest = {
  accountIdentity: Uint8Array;
  mlsSignaturePublicKey: Uint8Array;
  ciphersuite: number;
  signatureScheme: number;
};

export type AccountIdentityProof = {
  request: AccountIdentityProofRequest;
  signature: Uint8Array;
};

class BinaryWriter {
  private readonly chunks: number[] = [];

  uint8(n: number): this {
    this.chunks.push(n & 0xff);
    return this;
  }

  uint16(n: number): this {
    this.chunks.push((n >> 8) & 0xff, n & 0xff);
    return this;
  }

  bytes(b: Uint8Array): this {
    for (let i = 0; i < b.length; i++) this.chunks.push(b[i]!);
    return this;
  }

  build(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

class BinaryReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  uint8(): number {
    if (this.offset >= this.data.length) throw new Error('proof truncated');
    return this.data[this.offset++]!;
  }

  uint16(): number {
    const hi = this.uint8();
    const lo = this.uint8();
    return (hi << 8) | lo;
  }

  bytes(n: number): Uint8Array {
    if (this.offset + n > this.data.length) throw new Error('proof truncated');
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  end(): void {
    if (this.offset !== this.data.length)
      throw new Error('proof trailing bytes');
  }
}

function canonicalMessage(request: AccountIdentityProofRequest): Uint8Array {
  return new BinaryWriter()
    .bytes(new TextEncoder().encode(ACCOUNT_IDENTITY_PROOF_DOMAIN))
    .uint8(0)
    .uint16(ACCOUNT_IDENTITY_PROOF_EXT)
    .uint8(ACCOUNT_IDENTITY_PROOF_VERSION)
    .uint16(request.ciphersuite)
    .uint16(request.signatureScheme)
    .uint16(request.accountIdentity.length)
    .bytes(request.accountIdentity)
    .uint16(request.mlsSignaturePublicKey.length)
    .bytes(request.mlsSignaturePublicKey)
    .build();
}

export function accountIdentityProofSigningDigest(
  request: AccountIdentityProofRequest
): Uint8Array {
  return sha256(canonicalMessage(request));
}

export function signAccountIdentityProof(
  request: AccountIdentityProofRequest,
  secretKey: Uint8Array
): Uint8Array {
  return schnorr.sign(accountIdentityProofSigningDigest(request), secretKey);
}

export function encodeAccountIdentityProof(
  proof: AccountIdentityProof
): Uint8Array {
  if (proof.request.accountIdentity.length !== ACCOUNT_IDENTITY_LEN) {
    throw new Error('account identity must be exactly 32 bytes');
  }
  if (proof.signature.length !== SCHNORR_SIGNATURE_LEN) {
    throw new Error('proof signature must be exactly 64 bytes');
  }
  return new BinaryWriter()
    .uint8(ACCOUNT_IDENTITY_PROOF_VERSION)
    .uint16(proof.request.ciphersuite)
    .uint16(proof.request.signatureScheme)
    .bytes(proof.request.accountIdentity)
    .uint16(proof.request.mlsSignaturePublicKey.length)
    .bytes(proof.request.mlsSignaturePublicKey)
    .bytes(proof.signature)
    .build();
}

export function decodeAccountIdentityProof(
  data: Uint8Array
): AccountIdentityProof {
  const reader = new BinaryReader(data);
  const version = reader.uint8();
  if (version !== ACCOUNT_IDENTITY_PROOF_VERSION) {
    throw new Error(`unsupported proof version ${version}`);
  }
  const ciphersuite = reader.uint16();
  const signatureScheme = reader.uint16();
  const accountIdentity = reader.bytes(ACCOUNT_IDENTITY_LEN);
  const keyLen = reader.uint16();
  const mlsSignaturePublicKey = reader.bytes(keyLen);
  const signature = reader.bytes(SCHNORR_SIGNATURE_LEN);
  reader.end();
  return {
    request: {
      accountIdentity,
      mlsSignaturePublicKey,
      ciphersuite,
      signatureScheme,
    },
    signature,
  };
}

export function makeAccountIdentityProofExtension(
  proof: AccountIdentityProof
): CustomExtension {
  return makeCustomExtension({
    extensionType: ACCOUNT_IDENTITY_PROOF_EXT,
    extensionData: encodeAccountIdentityProof(proof),
  });
}

export function buildAccountIdentityProofExtension(params: {
  accountIdentity: Uint8Array;
  mlsSignaturePublicKey: Uint8Array;
  ciphersuite: number;
  identitySecret: Uint8Array;
}): CustomExtension {
  const request: AccountIdentityProofRequest = {
    accountIdentity: params.accountIdentity,
    mlsSignaturePublicKey: params.mlsSignaturePublicKey,
    ciphersuite: params.ciphersuite,
    signatureScheme: mlsSignatureScheme(params.ciphersuite),
  };
  return makeAccountIdentityProofExtension({
    request,
    signature: signAccountIdentityProof(request, params.identitySecret),
  });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hexToBytes32(hex: string): Uint8Array {
  const raw = hex.toLowerCase();
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 64-char hex npub from a basic credential. Accepts Marmot 32-byte or ASCII hex. */
export function credentialPubkeyHex(credential: Credential): string | null {
  if (credential.credentialType !== defaultCredentialTypes.basic) return null;
  const identity = (credential as CredentialBasic).identity;
  if (identity.length === 32) return bytesToHex(identity);
  if (identity.length === 64) {
    const asText = new TextDecoder().decode(identity);
    if (/^[0-9a-f]{64}$/i.test(asText)) return asText.toLowerCase();
  }
  return null;
}

export function verifyLeafAccountIdentityProof(
  leaf: LeafNode,
  ciphersuite: number
): void {
  const pubkeyHex = credentialPubkeyHex(leaf.credential);
  if (!pubkeyHex) throw new Error('leaf credential is not a Nostr pubkey');
  const accountIdentityBytes = hexToBytes32(pubkeyHex);
  const extension = leaf.extensions.find(
    (e): e is CustomExtension => e.extensionType === ACCOUNT_IDENTITY_PROOF_EXT
  );
  if (!extension) {
    throw new Error(
      'missing marmot.account-identity-proof.v1 LeafNode extension'
    );
  }
  const proof = decodeAccountIdentityProof(extension.extensionData);
  if (!bytesEqual(proof.request.accountIdentity, accountIdentityBytes)) {
    throw new Error(
      'proof account identity does not match credential identity'
    );
  }
  if (
    !bytesEqual(proof.request.mlsSignaturePublicKey, leaf.signaturePublicKey)
  ) {
    throw new Error(
      'proof MLS signature key does not match leaf signature key'
    );
  }
  if (proof.request.ciphersuite !== ciphersuite) {
    throw new Error('proof ciphersuite does not match expected ciphersuite');
  }
  if (proof.request.signatureScheme !== mlsSignatureScheme(ciphersuite)) {
    throw new Error('proof signature scheme does not match ciphersuite');
  }
  const digest = accountIdentityProofSigningDigest(proof.request);
  if (!schnorr.verify(proof.signature, digest, accountIdentityBytes)) {
    throw new Error('proof signature does not verify for credential identity');
  }
}
