// MLS groups on Nostr.
//
// NIP-EE (https://nips.nostr.com/ee) is the group wire: kind 443 KeyPackage,
// unsigned kind 444 Welcome (gift-wrapped), kind 445 group events signed with a
// fresh ephemeral secp256k1 key. MLS signing keys are Ed25519 from mlsKeys.ts —
// not the Nostr identity. Inner application payloads are unsigned kind 9.
// Extra devices: same npub, new leaf (RFC 9420 Add + 0xF2F1 proof). Not the
// Marmot External Commit draft.
//
// Paytaca still speaks kind 30078 { data: { mlsKind, mlsMessage } } with inner
// 30117/30118/30119. Groups that pick up a Paytaca-only KeyPackage dual-publish
// that envelope so their client can join. NIP-17 gift-wrap stays for 1:1 DMs.

import {
  acceptAll,
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  clientStateDecoder,
  clientStateEncoder,
  createApplicationMessage,
  createCommit,
  createGroup,
  decode,
  defaultAppDataUpdateCallback,
  defaultCapabilities,
  defaultCredentialTypes,
  defaultExtensionTypes,
  defaultKeyRetentionConfig,
  defaultLifetime,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  defaultProposalTypes,
  encode,
  generateKeyPackageWithKey,
  getAppDataDictionary,
  getCiphersuiteImpl,
  joinGroup,
  makeCustomExtension,
  mlsExporter,
  mlsMessageDecoder,
  mlsMessageEncoder,
  processMessage,
  protocolVersions,
  selfRemoveProposalType,
  unsafeTestingAuthenticationService,
  wireformats,
  type ClientState,
  type CiphersuiteImpl,
  type KeyPackage,
  type MlsContext,
  type KeyPackageEqualityConfig,
  type MlsMessage,
  type PrivateKeyPackage,
} from 'ts-mls';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
} from 'nostr-tools';
import {
  encrypt as nip44Encrypt,
  decrypt as nip44Decrypt,
  getConversationKey,
} from 'nostr-tools/nip44';
import { unwrapEvent } from 'nostr-tools/nip17';
import { wrapManyEvents as wrapRumor } from 'nostr-tools/nip59';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { deriveMlsKeys } from './mlsKeys';
import {
  APP_DATA_DICTIONARY_EXT,
  KIND_KEYPACKAGE_MARMOT,
  LAST_RESORT_EXT,
  makeMarmotAppDataExtension,
} from './mlsMarmot';
import {
  ACCOUNT_IDENTITY_PROOF_EXT,
  buildAccountIdentityProofExtension,
  credentialPubkeyHex,
} from './mlsIdentityProof';
import {
  coalescedMemberPubKeys,
  leafHasSignatureKey,
  loadMlsDeviceIndex,
  loadMlsKeyPackage,
  saveMlsKeyPackage,
} from './mlsDevice';

export {
  claimExtraMlsDeviceSlot,
  loadMlsDeviceIndex,
  coalescedMemberPubKeys,
  leafCountForPubkey,
  mlsLeafCount,
} from './mlsDevice';
export {
  ACCOUNT_IDENTITY_PROOF_EXT,
  verifyLeafAccountIdentityProof,
} from './mlsIdentityProof';
import { deriveNostrIdentity, loadNostrAccountSeed } from './identity';
import { DISCOVERY_RELAYS, DEFAULT_RELAYS } from './defaultRelays';
import { SimplePool } from 'nostr-tools';
import { isInlineChatMedia, type ChatMessage } from './chat';
import {
  encodeNostrGroupData,
  MARMOT_GROUP_DATA_EXT,
} from './mlsGroupData';

export const MLS_KIND_APP = 30117;
export const MLS_KIND_COMMIT = 30118;
export const MLS_KIND_WELCOME = 30119;
export const MLS_KEY_PACKAGE_D = 'paytaca:mls-key-package';
export const KIND_KEYPACKAGE = 443;
export const KIND_KEYPACKAGE_ADDR = KIND_KEYPACKAGE_MARMOT;
export const KIND_WELCOME = 444;
export const KIND_GROUP = 445;
export const KIND_KP_RELAYS = 10051;
const KIND_30078 = 30078;
const GIFT_WRAP = 1059;

function sameSigKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** One npub may own several leaves (RFC 9750 §3.7). Default ts-mls equality also
 *  matches credentials, which would reject an extra-device Add. */
const extraDeviceKeyPackageEquality: KeyPackageEqualityConfig = {
  compareKeyPackages(a, b) {
    return sameSigKey(a.leafNode.signaturePublicKey, b.leafNode.signaturePublicKey);
  },
  compareKeyPackageToLeafNode(a, b) {
    return sameSigKey(a.leafNode.signaturePublicKey, b.signaturePublicKey);
  },
};

const restoredClientConfig = {
  keyRetentionConfig: defaultKeyRetentionConfig,
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: extraDeviceKeyPackageEquality,
  paddingConfig: defaultPaddingConfig,
  appDataUpdateCallback: defaultAppDataUpdateCallback,
};

export function mlsContext(impl: CiphersuiteImpl): MlsContext {
  return {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
    clientConfig: restoredClientConfig,
  };
}

const CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;
const CIPHERSUITE_ID = '0x0001';

export type MlsWire = 'nip-ee' | 'paytaca';
export type MlsVisibility = 'private' | 'open';

/** NIP-17 itself says >10 should use another scheme. Private MLS gift-wraps each member. */
export const PRIVATE_MLS_MAX_MEMBERS = 8;

export type MlsGroupRecord = {
  nostrGroupIdHex: string;
  mlsGroupIdHex: string;
  roomId: string;
  wire: MlsWire;
  visibility: MlsVisibility;
  name: string;
  paytacaDual: boolean;
  memberPubKeys: string[];
  ownerPubKey: string;
};

let pool: SimplePool | null = null;
const getPool = () => (pool ??= new SimplePool());

const mlsStates = new Map<string, ClientState>();
const groupIndex = new Map<string, MlsGroupRecord>();

async function walletMnemonic(walletId: number) {
  const seed = await loadNostrAccountSeed(walletId);
  return { mnemonic: seed.mnemonic, passphrase: seed.passphrase };
}

export async function ensureMlsCrypto() {
  const impl = await getCiphersuiteImpl(CIPHERSUITE);
  return { impl };
}

export type GenerateMlsKeyPackageOpts = {
  deviceIndex?: number;
  identitySecret?: Uint8Array;
  persist?: boolean;
};

export async function generateMlsKeyPackage(
  nostrPubkeyHex: string,
  mnemonic: string,
  passphrase = '',
  opts?: GenerateMlsKeyPackageOpts
): Promise<{ publicPackage: KeyPackage; privatePackage: PrivateKeyPackage }> {
  const { impl } = await ensureMlsCrypto();
  const deviceIndex = opts?.deviceIndex ?? 0;
  const mlsKeys = await deriveMlsKeys(mnemonic, passphrase, deviceIndex);
  const accountIdentity = hexToBytes(nostrPubkeyHex);
  const identitySecret =
    opts?.identitySecret ?? (await deriveNostrIdentity(mnemonic, passphrase)).secretKey;
  const credential = {
    credentialType: defaultCredentialTypes.basic,
    identity: accountIdentity,
  };
  const capabilities = defaultCapabilities();
  capabilities.extensions = [
    ...capabilities.extensions,
    APP_DATA_DICTIONARY_EXT,
    MARMOT_GROUP_DATA_EXT,
    LAST_RESORT_EXT,
    ACCOUNT_IDENTITY_PROOF_EXT,
  ];
  capabilities.proposals = [
    ...capabilities.proposals,
    appDataUpdateProposalType,
    selfRemoveProposalType,
  ];
  const identityProof = buildAccountIdentityProofExtension({
    accountIdentity,
    mlsSignaturePublicKey: mlsKeys.publicKey,
    ciphersuite: impl.id,
    identitySecret,
  });
  const generated = await generateKeyPackageWithKey({
    credential,
    capabilities,
    lifetime: defaultLifetime(),
    extensions: [
      makeCustomExtension({
        extensionType: LAST_RESORT_EXT,
        extensionData: new Uint8Array(0),
      }),
    ],
    leafNodeExtensions: [identityProof],
    signatureKeyPair: {
      signKey: mlsKeys.privateKey,
      publicKey: mlsKeys.publicKey,
    },
    cipherSuite: impl,
  });
  if (opts?.persist) {
    await saveMlsKeyPackage(
      nostrPubkeyHex,
      deviceIndex,
      generated.publicPackage,
      generated.privatePackage
    );
  }
  return generated;
}

export async function loadOrCreateMlsKeyPackage(
  nostrPubkeyHex: string,
  mnemonic: string,
  passphrase = '',
  deviceIndex = 0,
  identitySecret?: Uint8Array
): Promise<{ publicPackage: KeyPackage; privatePackage: PrivateKeyPackage }> {
  const stored = await loadMlsKeyPackage(nostrPubkeyHex, deviceIndex);
  if (stored) return stored;
  return generateMlsKeyPackage(nostrPubkeyHex, mnemonic, passphrase, {
    deviceIndex,
    identitySecret,
    persist: true,
  });
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64ToBytes(str: string): Uint8Array {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function encodeMlsBytes(msg: MlsMessage): Uint8Array {
  return encode(mlsMessageEncoder, msg);
}

export function decodeMlsBytes(bytes: Uint8Array): MlsMessage | null {
  return decode(mlsMessageDecoder, bytes) ?? null;
}

export function wrapPrivateMessage(
  privateMessage: Extract<
    Awaited<ReturnType<typeof createApplicationMessage>>['message'],
    { privateMessage: unknown }
  >['privateMessage']
): MlsMessage {
  return {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_private_message,
    privateMessage,
  };
}

export function wrapWelcome(
  welcome: NonNullable<Awaited<ReturnType<typeof createCommit>>['welcome']>
): MlsMessage {
  return welcome;
}

function wrapKeyPackage(keyPackage: KeyPackage): MlsMessage {
  return {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_key_package,
    keyPackage,
  };
}

export async function nostrExporterKey(state: ClientState): Promise<Uint8Array> {
  const { impl } = await ensureMlsCrypto();
  return mlsExporter(
    state.keySchedule.exporterSecret,
    'nostr',
    new Uint8Array(0),
    32,
    impl
  );
}

export async function marmotGroupEventKey(state: ClientState): Promise<Uint8Array> {
  const { impl } = await ensureMlsCrypto();
  return mlsExporter(
    state.keySchedule.exporterSecret,
    'marmot',
    new TextEncoder().encode('group-event'),
    32,
    impl
  );
}

export function nip44EncryptWithExporter(exporter: Uint8Array, plaintext: string): string {
  const pub = getPublicKey(exporter);
  return nip44Encrypt(plaintext, getConversationKey(exporter, pub));
}

export function nip44DecryptWithExporter(exporter: Uint8Array, payload: string): string {
  const pub = getPublicKey(exporter);
  return nip44Decrypt(payload, getConversationKey(exporter, pub));
}

export function innerKind9(pubkey: string, text: string) {
  return {
    kind: 9,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content: text,
    tags: [] as string[][],
  };
}

export function innerKind15(
  pubkey: string,
  dataUrl: string,
  mime = 'image/jpeg',
  fileName?: string
) {
  const tags: string[][] = [['file-type', mime]];
  if (fileName) tags.push(['filename', fileName]);
  return {
    kind: 15,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content: dataUrl,
    tags,
  };
}

export function parseApplicationPayload(bytes: Uint8Array): {
  text: string;
  from?: string;
  at?: number;
  kind?: number;
} {
  const raw = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(raw) as {
      kind?: number;
      content?: string;
      pubkey?: string;
      created_at?: number;
    };
    if (
      (parsed.kind === 9 || parsed.kind === 14 || parsed.kind === 15) &&
      typeof parsed.content === 'string'
    ) {
      return {
        text: parsed.content,
        from: parsed.pubkey,
        at: parsed.created_at,
        kind: parsed.kind,
      };
    }
  } catch {
    /* raw utf-8 from Paytaca */
  }
  return { text: raw };
}

const INDEX_KEY = (pubkey: string) => `nostr-mls-index:${pubkey}`;
const RATCHET_KEY = (pubkey: string, nostrGroupIdHex: string) =>
  `nostr-mls-ratchet:${pubkey}:${nostrGroupIdHex}`;

export async function saveMlsState(
  nostrGroupIdHex: string,
  state: ClientState,
  ownerPubKey?: string,
  ownerSecret?: Uint8Array
) {
  mlsStates.set(nostrGroupIdHex, state);
  const owner = ownerPubKey || getMlsRecord(nostrGroupIdHex)?.ownerPubKey;
  if (!owner) return;
  try {
    const bytes = encode(clientStateEncoder, state);
    const b64 = bytesToB64(bytes);
    await idbSet(RATCHET_KEY(owner, nostrGroupIdHex), b64);
    if (ownerSecret) {
      const rumor = {
        kind: KIND_30078,
        pubkey: owner,
        created_at: Math.floor(Date.now() / 1000),
        content: b64,
        tags: [['d', `optn:mls-backup:${nostrGroupIdHex}`]],
      };
      const wraps = wrapRumor(rumor, ownerSecret, [owner]) as Event[];
      void publish([...DISCOVERY_RELAYS], wraps);
    }
  } catch {
    /* encoder may reject a live ClientState extra field — memory still holds it */
  }
}

export async function loadMlsState(
  nostrGroupIdHex: string,
  ownerPubKey?: string
): Promise<ClientState | null> {
  const mem = mlsStates.get(nostrGroupIdHex);
  if (mem) return mem;
  const owner = ownerPubKey || getMlsRecord(nostrGroupIdHex)?.ownerPubKey;
  if (!owner) return null;
  try {
    const b64 = await idbGet(RATCHET_KEY(owner, nostrGroupIdHex));
    if (typeof b64 !== 'string') return null;
    const groupState = decode(clientStateDecoder, b64ToBytes(b64));
    if (!groupState) return null;
    const state = { ...groupState, clientConfig: restoredClientConfig } as ClientState;
    mlsStates.set(nostrGroupIdHex, state);
    return state;
  } catch {
    return null;
  }
}

export function getMlsRecord(nostrGroupIdHex: string): MlsGroupRecord | null {
  return groupIndex.get(nostrGroupIdHex) ?? null;
}

export function listMlsGroups(): MlsGroupRecord[] {
  return [...groupIndex.values()];
}

function rememberGroup(record: MlsGroupRecord) {
  groupIndex.set(record.nostrGroupIdHex, record);
}

async function persistIndex(pubkey: string) {
  try {
    await idbSet(INDEX_KEY(pubkey), listMlsGroups());
  } catch {
    /* best-effort */
  }
}

export async function loadMlsIndex(pubkey: string): Promise<MlsGroupRecord[]> {
  try {
    const stored = await idbGet(INDEX_KEY(pubkey));
    if (Array.isArray(stored)) {
      for (const rec of stored as MlsGroupRecord[]) {
        if (rec?.nostrGroupIdHex) {
          rec.visibility = rec.visibility || 'open';
          rec.memberPubKeys = rec.memberPubKeys || [pubkey];
          rec.ownerPubKey = rec.ownerPubKey || pubkey;
          rememberGroup(rec);
          await loadMlsState(rec.nostrGroupIdHex, pubkey);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return listMlsGroups();
}

export function getMlsGroupMembers(state: ClientState): string[] {
  return coalescedMemberPubKeys(state);
}

export function decodeMlsEventContent(content: string): {
  kind: number | null;
  bytes: Uint8Array | null;
} {
  try {
    const parsed = JSON.parse(content) as {
      data?: { mlsMessage?: string; mlsKind?: number };
    };
    if (parsed?.data && typeof parsed.data.mlsMessage === 'string') {
      return {
        kind: parsed.data.mlsKind ?? null,
        bytes: b64ToBytes(parsed.data.mlsMessage),
      };
    }
  } catch {
    /* not an MLS envelope */
  }
  return { kind: null, bytes: null };
}

export function buildPaytacaMlsEvent(
  mlsMsg: MlsMessage,
  mlsKind: number,
  mlsGroupIdHex: string,
  roomId: string
) {
  const bytes = encodeMlsBytes(mlsMsg);
  return {
    kind: KIND_30078,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', `paytaca:mls:${mlsGroupIdHex}:${mlsKind}`],
      ['h', mlsGroupIdHex],
      ['r', roomId],
      ['k', String(mlsKind)],
    ],
    content: JSON.stringify({
      name: 'Paytaca MLS',
      data: { mlsKind, mlsMessage: bytesToB64(bytes) },
    }),
  };
}

/** @deprecated identity-signed 30078 leak — use buildPaytacaMlsEvent */
export const buildMlsNostrEvent = (
  mlsMsg: MlsMessage,
  mlsKind: number,
  mlsGroupIdHex: string,
  roomId: string,
  senderPubKey?: string,
  members: string[] = []
) => {
  void senderPubKey;
  void members;
  return buildPaytacaMlsEvent(mlsMsg, mlsKind, mlsGroupIdHex, roomId);
};

export async function encryptKind445Content(
  state: ClientState,
  mlsMsg: MlsMessage
): Promise<string> {
  const key = await marmotGroupEventKey(state);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  try {
    const packed = concatBytes(
      nonce,
      chacha20poly1305(key, nonce).encrypt(encodeMlsBytes(mlsMsg))
    );
    return bytesToB64(packed);
  } finally {
    key.fill(0);
  }
}

export async function decryptKind445Content(
  state: ClientState,
  content: string
): Promise<MlsMessage | null> {
  try {
    const packed = b64ToBytes(content);
    if (packed.length > 12) {
      const key = await marmotGroupEventKey(state);
      try {
        const plain = chacha20poly1305(key, packed.subarray(0, 12)).decrypt(
          packed.subarray(12)
        );
        const msg = decodeMlsBytes(plain);
        if (msg) return msg;
      } finally {
        key.fill(0);
      }
    }
  } catch {
    /* try NIP-ee NIP-44 */
  }
  const exporter = await nostrExporterKey(state);
  try {
    const hex = nip44DecryptWithExporter(exporter, content);
    return decodeMlsBytes(hexToBytes(hex));
  } catch {
    return null;
  } finally {
    exporter.fill(0);
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function buildKind443(
  keyPackage: KeyPackage,
  identitySecret: Uint8Array,
  relays: string[]
): Event {
  const hex = bytesToHex(encodeMlsBytes(wrapKeyPackage(keyPackage)));
  return finalizeEvent(
    {
      kind: KIND_KEYPACKAGE,
      created_at: Math.floor(Date.now() / 1000),
      content: hex,
      tags: [
        ['mls_protocol_version', '1.0'],
        ['ciphersuite', CIPHERSUITE_ID],
        ['mls_extensions', '0x0006', '0xf2ee', '0x000a', '0xf2f1'],
        ['relays', ...relays],
        ['-'],
      ],
    },
    identitySecret
  );
}

export function buildKind30443(
  keyPackage: KeyPackage,
  identitySecret: Uint8Array,
  relays: string[],
  deviceIndex = 0
): Event {
  const hex = bytesToHex(encodeMlsBytes(wrapKeyPackage(keyPackage)));
  return finalizeEvent(
    {
      kind: KIND_KEYPACKAGE_ADDR,
      created_at: Math.floor(Date.now() / 1000),
      content: hex,
      tags: [
        ['d', String(deviceIndex)],
        ['mls_protocol_version', '1.0'],
        ['ciphersuite', CIPHERSUITE_ID],
        ['mls_extensions', '0x0006', '0xf2ee', '0x000a', '0xf2f1'],
        ['relays', ...relays],
        ['-'],
      ],
    },
    identitySecret
  );
}

export function buildKind10051(relays: string[], identitySecret: Uint8Array): Event {
  return finalizeEvent(
    {
      kind: KIND_KP_RELAYS,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: relays.map((url) => ['relay', url]),
    },
    identitySecret
  );
}

export async function buildKind445(
  state: ClientState,
  mlsMsg: MlsMessage,
  nostrGroupIdHex: string
): Promise<Event> {
  const content = await encryptKind445Content(state, mlsMsg);
  const ephemeral = generateSecretKey();
  try {
    return finalizeEvent(
      {
        kind: KIND_GROUP,
        created_at: Math.floor(Date.now() / 1000),
        content,
        tags: [['h', nostrGroupIdHex]],
      },
      ephemeral
    );
  } finally {
    ephemeral.fill(0);
  }
}

export function unsignedMlsRumor(
  senderPubKey: string,
  nostrGroupIdHex: string,
  mlsMsg: MlsMessage
) {
  return {
    kind: KIND_GROUP,
    pubkey: senderPubKey,
    created_at: Math.floor(Date.now() / 1000),
    content: bytesToHex(encodeMlsBytes(mlsMsg)),
    tags: [['h', nostrGroupIdHex]] as string[][],
  };
}

export function unsignedKind444(
  senderPubKey: string,
  welcome: MlsMessage,
  relays: string[],
  keyPackageEventId?: string
) {
  const tags: string[][] = [['relays', ...relays]];
  if (keyPackageEventId) tags.push(['e', keyPackageEventId]);
  return {
    kind: KIND_WELCOME,
    pubkey: senderPubKey,
    created_at: Math.floor(Date.now() / 1000),
    content: bytesToHex(encodeMlsBytes(welcome)),
    tags,
  };
}

async function publish(targets: string[], evts: Event[]) {
  await Promise.allSettled(evts.flatMap((e) => getPool().publish(targets, e)));
}

export async function publishMlsKeyPackage(
  walletId: number,
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  const { mnemonic, passphrase } = await walletMnemonic(walletId);
  const nostr = await deriveNostrIdentity(mnemonic, passphrase);
  const deviceIndex = await loadMlsDeviceIndex(nostr.pubkey);
  const { publicPackage } = await loadOrCreateMlsKeyPackage(
    nostr.pubkey,
    mnemonic,
    passphrase,
    deviceIndex,
    nostr.secretKey
  );
  const targets = Array.from(new Set([...DISCOVERY_RELAYS, ...relays]));
  const kind443 = buildKind443(publicPackage, nostr.secretKey, targets);
  const kind30443 = buildKind30443(
    publicPackage,
    nostr.secretKey,
    targets,
    deviceIndex
  );
  const kind10051 = buildKind10051(targets, nostr.secretKey);
  const paytaca = finalizeEvent(
    {
      kind: KIND_30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', MLS_KEY_PACKAGE_D]],
      content: JSON.stringify({
        name: 'Paytaca MLS',
        data: { mlsMessage: bytesToB64(encodeMlsBytes(wrapKeyPackage(publicPackage))) },
      }),
    },
    nostr.secretKey
  );
  await publish(targets, [kind443, kind30443, kind10051, paytaca]);
}

function keyPackageFromEventContent(content: string): KeyPackage | null {
  const hex = content.match(/^[0-9a-f]+$/i) ? content : null;
  if (hex) {
    const msg = decodeMlsBytes(hexToBytes(hex));
    if (msg?.wireformat === wireformats.mls_key_package) return msg.keyPackage;
  }
  const paytaca = decodeMlsEventContent(content);
  if (paytaca.bytes) {
    const msg = decodeMlsBytes(paytaca.bytes);
    if (msg?.wireformat === wireformats.mls_key_package) return msg.keyPackage;
  }
  return null;
}

export async function fetchPeerKeyPackage(
  pubKey: string,
  relays: string[] = DEFAULT_RELAYS,
  opts?: { deviceIndex?: number }
): Promise<{ keyPackage: KeyPackage; source: MlsWire; eventId?: string } | null> {
  const lookup = Array.from(new Set([...DISCOVERY_RELAYS, ...relays]));
  const dFilter =
    typeof opts?.deviceIndex === 'number'
      ? { '#d': [String(opts.deviceIndex)] }
      : {};
  const nipEe =
    (await getPool().get(lookup, {
      kinds: [KIND_KEYPACKAGE_ADDR],
      authors: [pubKey],
      ...dFilter,
    })) ??
    (await getPool().get(lookup, {
      kinds: [KIND_KEYPACKAGE],
      authors: [pubKey],
    }));
  if (nipEe) {
    const kp = keyPackageFromEventContent(nipEe.content);
    if (kp) return { keyPackage: kp, source: 'nip-ee', eventId: nipEe.id };
  }
  const paytaca = await getPool().get(lookup, {
    kinds: [KIND_30078],
    authors: [pubKey],
    '#d': [MLS_KEY_PACKAGE_D],
  });
  if (paytaca) {
    const kp = keyPackageFromEventContent(paytaca.content);
    if (kp) return { keyPackage: kp, source: 'paytaca', eventId: paytaca.id };
  }
  return null;
}

export async function createMlsGroup(
  walletId: number,
  name: string,
  myPubkey: string,
  opts?: { visibility?: MlsVisibility; relays?: string[] }
): Promise<MlsGroupRecord> {
  const { mnemonic, passphrase } = await walletMnemonic(walletId);
  const { impl } = await ensureMlsCrypto();
  const deviceIndex = await loadMlsDeviceIndex(myPubkey);
  const nostr = await deriveNostrIdentity(mnemonic, passphrase);
  const { publicPackage, privatePackage } = await loadOrCreateMlsKeyPackage(
    myPubkey,
    mnemonic,
    passphrase,
    deviceIndex,
    nostr.secretKey
  );
  const mlsGroupId = crypto.getRandomValues(new Uint8Array(32));
  const nostrGroupId = crypto.getRandomValues(new Uint8Array(32));
  const relays = opts?.relays?.length
    ? opts.relays
    : [...DISCOVERY_RELAYS];
  const groupData = encodeNostrGroupData({
    nostrGroupId,
    name: name || 'MLS Group',
    description: '',
    adminPubKeys: [myPubkey],
    relays,
  });
  const extensions = [
    makeMarmotAppDataExtension({
      name: name || 'MLS Group',
      description: '',
      adminPubKey: myPubkey,
      nostrGroupId,
      relays,
    }),
    makeCustomExtension({
      extensionType: MARMOT_GROUP_DATA_EXT,
      extensionData: groupData,
    }),
    {
      extensionType: defaultExtensionTypes.required_capabilities,
      extensionData: {
        extensionTypes: [appDataDictionaryExtensionType],
        proposalTypes: [appDataUpdateProposalType, selfRemoveProposalType].sort(
          (a, b) => a - b
        ),
        credentialTypes: [],
      },
    },
  ];
  const clientState = await createGroup({
    context: mlsContext(impl),
    groupId: mlsGroupId,
    keyPackage: publicPackage,
    privateKeyPackage: privatePackage,
    extensions,
  });
  const record: MlsGroupRecord = {
    nostrGroupIdHex: bytesToHex(nostrGroupId),
    mlsGroupIdHex: bytesToHex(mlsGroupId),
    roomId: crypto.randomUUID(),
    wire: 'nip-ee',
    visibility: opts?.visibility ?? 'open',
    name: name || 'MLS Group',
    paytacaDual: false,
    memberPubKeys: [myPubkey],
    ownerPubKey: myPubkey,
  };
  rememberGroup(record);
  await saveMlsState(record.nostrGroupIdHex, clientState, myPubkey, nostr.secretKey);
  await persistIndex(myPubkey);
  return record;
}

export async function encryptMlsMessage(state: ClientState, text: string) {
  const { impl } = await ensureMlsCrypto();
  return createApplicationMessage({
    context: mlsContext(impl),
    state,
    message: new TextEncoder().encode(text),
  });
}

export async function commitAddMember(
  state: ClientState,
  inviteeKeyPackage: KeyPackage
) {
  const { impl } = await ensureMlsCrypto();
  return createCommit({
    context: mlsContext(impl),
    state,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: inviteeKeyPackage },
      },
    ],
    ratchetTreeExtension: true,
  });
}

export async function commitAppDataUpdate(
  state: ClientState,
  componentId: number,
  update: Uint8Array
) {
  const { impl } = await ensureMlsCrypto();
  return createCommit({
    context: mlsContext(impl),
    state,
    extraProposals: [
      {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: { componentId, operation: 'update', update },
      },
    ],
  });
}

export function readMlsAppData(state: ClientState) {
  return getAppDataDictionary(state.groupContext.extensions);
}

export async function sendMlsMessage(
  walletId: number,
  nostrGroupIdHex: string,
  roomId: string,
  text: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<{ id: string; at: number }> {
  const { mnemonic, passphrase } = await walletMnemonic(walletId);
  const nostr = await deriveNostrIdentity(mnemonic, passphrase);
  return sendMlsPayload(
    walletId,
    nostrGroupIdHex,
    roomId,
    JSON.stringify(innerKind9(nostr.pubkey, text)),
    relays
  );
}

export async function sendMlsPhoto(
  walletId: number,
  nostrGroupIdHex: string,
  roomId: string,
  dataUrl: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<{ id: string; at: number }> {
  return sendMlsFile(walletId, nostrGroupIdHex, roomId, dataUrl, relays);
}

export async function sendMlsFile(
  walletId: number,
  nostrGroupIdHex: string,
  roomId: string,
  dataUrl: string,
  relays: string[] = DEFAULT_RELAYS,
  extra?: { mimeType?: string; fileName?: string }
): Promise<{ id: string; at: number }> {
  if (!isInlineChatMedia(dataUrl)) {
    throw new Error('Chat files must be inline data, not a URL');
  }
  const { mnemonic, passphrase } = await walletMnemonic(walletId);
  const nostr = await deriveNostrIdentity(mnemonic, passphrase);
  return sendMlsPayload(
    walletId,
    nostrGroupIdHex,
    roomId,
    JSON.stringify(
      innerKind15(
        nostr.pubkey,
        dataUrl,
        extra?.mimeType,
        extra?.fileName
      )
    ),
    relays
  );
}

async function sendMlsPayload(
  walletId: number,
  nostrGroupIdHex: string,
  roomId: string,
  payloadJson: string,
  relays: string[]
): Promise<{ id: string; at: number }> {
  const { mnemonic, passphrase } = await walletMnemonic(walletId);
  const nostr = await deriveNostrIdentity(mnemonic, passphrase);
  const loaded = await loadMlsState(nostrGroupIdHex);
  if (!loaded) throw new Error('MLS group state not found');
  const record = getMlsRecord(nostrGroupIdHex);
  const payload = payloadJson;
  const { message: wrapped, newState } = await encryptMlsMessage(
    loaded,
    typeof payload === 'string' ? payload : JSON.stringify(payload)
  );
  const targets = Array.from(new Set([...DISCOVERY_RELAYS, ...relays]));
  const published: Event[] = [];
  if (record?.visibility === 'private') {
    const rumor = unsignedMlsRumor(nostr.pubkey, nostrGroupIdHex, wrapped);
    const members = (record.memberPubKeys || []).filter((p) => p !== nostr.pubkey);
    if (members.length) {
      published.push(...(wrapRumor(rumor, nostr.secretKey, members) as Event[]));
    }
  } else {
    published.push(await buildKind445(newState, wrapped, nostrGroupIdHex));
  }
  if (record?.paytacaDual || record?.wire === 'paytaca') {
    const unsigned = buildPaytacaMlsEvent(
      wrapped,
      MLS_KIND_APP,
      record.mlsGroupIdHex,
      roomId || record.roomId
    );
    published.push(finalizeEvent(unsigned, nostr.secretKey));
  }
  await saveMlsState(nostrGroupIdHex, newState, nostr.pubkey, nostr.secretKey);
  await publish(targets, published);
  const first = published[0];
  return { id: first?.id ?? bytesToHex(crypto.getRandomValues(new Uint8Array(16))), at: Math.floor(Date.now() / 1000) };
}

export async function addMlsMember(
  walletId: number,
  nostrGroupIdHex: string,
  inviteePubKey: string,
  relays: string[] = DEFAULT_RELAYS,
  opts?: { deviceIndex?: number }
): Promise<void> {
  const { mnemonic, passphrase } = await walletMnemonic(walletId);
  const nostr = await deriveNostrIdentity(mnemonic, passphrase);
  const loaded = await loadMlsState(nostrGroupIdHex);
  if (!loaded) throw new Error('MLS group state not found');
  const fetched = await fetchPeerKeyPackage(inviteePubKey, relays, opts);
  if (!fetched) {
    throw new Error(
      'Peer has no MLS KeyPackage yet. They need to open chat once (kind 443).'
    );
  }
  const kpIdentity = credentialPubkeyHex(fetched.keyPackage.leafNode.credential);
  if (kpIdentity && kpIdentity !== inviteePubKey.toLowerCase()) {
    throw new Error('KeyPackage credential does not match invitee npub');
  }
  if (leafHasSignatureKey(loaded, fetched.keyPackage.leafNode.signaturePublicKey)) {
    return;
  }
  const record = getMlsRecord(nostrGroupIdHex);
  const alreadyMember = record?.memberPubKeys.includes(inviteePubKey) ?? false;
  if (
    record?.visibility === 'private' &&
    !alreadyMember &&
    (record.memberPubKeys?.length ?? 1) >= PRIVATE_MLS_MAX_MEMBERS
  ) {
    throw new Error(
      `Private groups are capped at ${PRIVATE_MLS_MAX_MEMBERS} members. Create an open MLS group for more.`
    );
  }
  const result = await commitAddMember(loaded, fetched.keyPackage);
  if (record) {
    if (fetched.source === 'paytaca') record.paytacaDual = true;
    if (!record.memberPubKeys.includes(inviteePubKey)) {
      record.memberPubKeys.push(inviteePubKey);
    }
    rememberGroup(record);
    await persistIndex(nostr.pubkey);
  }
  const targets = Array.from(new Set([...DISCOVERY_RELAYS, ...relays]));
  const published: Event[] = [];
  if (record?.visibility === 'private') {
    const rumor = unsignedMlsRumor(nostr.pubkey, nostrGroupIdHex, result.commit);
    const members = (record.memberPubKeys || []).filter((p) => p !== nostr.pubkey);
    if (members.length) {
      published.push(...(wrapRumor(rumor, nostr.secretKey, members) as Event[]));
    }
  } else {
    published.push(await buildKind445(result.newState, result.commit, nostrGroupIdHex));
  }
  if (result.welcome) {
    const welcomeMsg = result.welcome;
    const rumor = unsignedKind444(
      nostr.pubkey,
      welcomeMsg,
      targets,
      fetched.eventId
    );
    const wraps = wrapRumor(rumor, nostr.secretKey, [inviteePubKey]) as Event[];
    published.push(...wraps);
    if (fetched.source === 'paytaca' && record) {
      const welcomeUnsigned = buildPaytacaMlsEvent(
        welcomeMsg,
        MLS_KIND_WELCOME,
        record.mlsGroupIdHex,
        record.roomId
      );
      published.push(finalizeEvent(welcomeUnsigned, nostr.secretKey));
      const commitUnsigned = buildPaytacaMlsEvent(
        result.commit,
        MLS_KIND_COMMIT,
        record.mlsGroupIdHex,
        record.roomId
      );
      published.push(finalizeEvent(commitUnsigned, nostr.secretKey));
    }
  }
  await saveMlsState(nostrGroupIdHex, result.newState, nostr.pubkey, nostr.secretKey);
  if (record) {
    record.memberPubKeys = coalescedMemberPubKeys(result.newState);
    rememberGroup(record);
    await persistIndex(nostr.pubkey);
  }
  await publish(targets, published);
}

/** Add this account's extra-device KeyPackage (kind 30443 `d=<index>`) as a new leaf. */
export async function linkOwnDevice(
  walletId: number,
  nostrGroupIdHex: string,
  extraDeviceIndex = 1,
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  const { mnemonic, passphrase } = await walletMnemonic(walletId);
  const nostr = await deriveNostrIdentity(mnemonic, passphrase);
  await addMlsMember(walletId, nostrGroupIdHex, nostr.pubkey, relays, {
    deviceIndex: extraDeviceIndex,
  });
}

export async function joinMlsGroupFromWelcome(
  walletId: number,
  myPubkey: string,
  welcomeBytes: Uint8Array,
  roomId: string,
  nostrGroupIdHex?: string,
  wire: MlsWire = 'nip-ee'
): Promise<string> {
  const { mnemonic, passphrase } = await walletMnemonic(walletId);
  const { impl } = await ensureMlsCrypto();
  const mlsMsg = decodeMlsBytes(welcomeBytes);
  if (!mlsMsg || mlsMsg.wireformat !== wireformats.mls_welcome) {
    throw new Error('Expected a Welcome message');
  }
  const ident = await deriveNostrIdentity(mnemonic, passphrase);
  const deviceIndex = await loadMlsDeviceIndex(myPubkey);
  const { publicPackage, privatePackage } = await loadOrCreateMlsKeyPackage(
    myPubkey,
    mnemonic,
    passphrase,
    deviceIndex,
    ident.secretKey
  );
  const clientState = await joinGroup({
    context: mlsContext(impl),
    welcome: mlsMsg.welcome,
    keyPackage: publicPackage,
    privateKeys: privatePackage,
  });
  const mlsGroupIdHex = bytesToHex(clientState.groupContext.groupId);
  const existing = listMlsGroups().find((r) => r.mlsGroupIdHex === mlsGroupIdHex);
  if (existing) {
    existing.memberPubKeys = coalescedMemberPubKeys(clientState);
    rememberGroup(existing);
    await saveMlsState(existing.nostrGroupIdHex, clientState, myPubkey, ident.secretKey);
    await persistIndex(myPubkey);
    return existing.nostrGroupIdHex;
  }
  const handle = nostrGroupIdHex || mlsGroupIdHex;
  const record: MlsGroupRecord = {
    nostrGroupIdHex: handle,
    mlsGroupIdHex,
    roomId: roomId || crypto.randomUUID(),
    wire,
    visibility: wire === 'paytaca' ? 'open' : 'private',
    name: 'MLS Group',
    paytacaDual: wire === 'paytaca',
    memberPubKeys: coalescedMemberPubKeys(clientState),
    ownerPubKey: myPubkey,
  };
  rememberGroup(record);
  await saveMlsState(handle, clientState, myPubkey, ident.secretKey);
  await persistIndex(myPubkey);
  return handle;
}

export async function processMlsMessage(
  nostrGroupIdHex: string,
  bytes: Uint8Array
): Promise<{ plaintext?: string; from?: string; at?: number; kind?: number }> {
  const { impl } = await ensureMlsCrypto();
  const loaded = await loadMlsState(nostrGroupIdHex);
  if (!loaded) return {};
  const mlsMsg = decodeMlsBytes(bytes);
  if (!mlsMsg) return {};
  if (
    mlsMsg.wireformat !== wireformats.mls_private_message &&
    mlsMsg.wireformat !== wireformats.mls_public_message
  ) {
    if (mlsMsg.wireformat === wireformats.mls_welcome) return {};
    return {};
  }
  const processed = await processMessage({
    context: mlsContext(impl),
    state: loaded,
    message: mlsMsg,
    callback: acceptAll,
  });
  await saveMlsState(
    nostrGroupIdHex,
    processed.newState,
    getMlsRecord(nostrGroupIdHex)?.ownerPubKey
  );
  if (processed.kind === 'applicationMessage') {
    return parseApplicationPayload(processed.message);
  }
  return {};
}

async function handleGroupEvent(
  evt: Event,
  onMessage: (m: ChatMessage) => void,
  myPubkey: string
) {
  if (evt.kind !== KIND_GROUP) return;
  const h = evt.tags.find((t) => t[0] === 'h')?.[1];
  if (!h) return;
  const state = await loadMlsState(h);
  if (!state) return;
  const mlsMsg = await decryptKind445Content(state, evt.content);
  if (!mlsMsg) return;
  const out = await processMlsMessage(h, encodeMlsBytes(mlsMsg));
  if (!out.plaintext) return;
  onMessage({
    id: evt.id,
    from: out.from || '',
    to: [],
    text: out.plaintext,
    at: out.at || evt.created_at,
    mine: (out.from || '') === myPubkey,
    kind: out.kind,
    roomId: getMlsRecord(h)?.roomId,
  });
}

async function handlePaytacaEnvelope(
  evt: Event,
  onMessage: (m: ChatMessage) => void,
  walletId: number,
  myPubkey: string
) {
  if (evt.kind !== KIND_30078) return;
  const decoded = decodeMlsEventContent(evt.content);
  if (!decoded.bytes) return;
  const h = evt.tags.find((t) => t[0] === 'h')?.[1];
  const mlsMsg = decodeMlsBytes(decoded.bytes);
  if (mlsMsg?.wireformat === wireformats.mls_welcome) {
    const handle = await joinMlsGroupFromWelcome(
      walletId,
      myPubkey,
      decoded.bytes,
      evt.tags.find((t) => t[0] === 'r')?.[1] || '',
      h,
      'paytaca'
    );
    void handle;
    return;
  }
  if (!h) return;
  const out = await processMlsMessage(h, decoded.bytes);
  if (!out.plaintext) return;
  onMessage({
    id: evt.id,
    from: out.from || evt.pubkey,
    to: [],
    text: out.plaintext,
    at: out.at || evt.created_at,
    mine: (out.from || evt.pubkey) === myPubkey,
    kind: out.kind,
    roomId: getMlsRecord(h)?.roomId,
  });
}

export async function ingestMlsGiftWrap(
  walletId: number,
  evt: Event,
  onMessage: (m: ChatMessage) => void,
  myPubkey: string,
  secretKey: Uint8Array
): Promise<void> {
  if (evt.kind !== GIFT_WRAP) return;
  const rumor = unwrapEvent(evt, secretKey);
  if (rumor.kind === KIND_30078) {
    const d = rumor.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    if (d.startsWith('optn:mls-backup:')) {
      const gid = d.slice('optn:mls-backup:'.length);
      const decoded = decode(clientStateDecoder, b64ToBytes(rumor.content));
      if (decoded) {
        const state = {
          ...decoded,
          clientConfig: restoredClientConfig,
        } as ClientState;
        mlsStates.set(gid, state);
        await idbSet(RATCHET_KEY(myPubkey, gid), rumor.content);
      }
    }
    return;
  }
  if (rumor.kind === KIND_WELCOME) {
    const bytes = hexToBytes(rumor.content);
    const h = rumor.tags.find((t) => t[0] === 'h')?.[1];
    const handle = await joinMlsGroupFromWelcome(
      walletId,
      myPubkey,
      bytes,
      '',
      h,
      'nip-ee'
    );
    const joined = getMlsRecord(handle);
    if (joined) {
      joined.visibility = 'private';
      rememberGroup(joined);
      await persistIndex(myPubkey);
    }
    return;
  }
  if (rumor.kind === KIND_GROUP) {
    const h = rumor.tags.find((t) => t[0] === 'h')?.[1];
    if (!h) return;
    const bytes = hexToBytes(rumor.content);
    const out = await processMlsMessage(h, bytes);
    if (!out.plaintext) return;
    onMessage({
      id: evt.id,
      from: out.from || rumor.pubkey,
      to: [],
      text: out.plaintext,
      at: out.at || rumor.created_at,
      mine: (out.from || rumor.pubkey) === myPubkey,
      kind: out.kind,
      roomId: getMlsRecord(h)?.roomId,
    });
  }
}

export async function refetchMlsInbox(
  walletId: number,
  onMessage: (m: ChatMessage) => void,
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  const { mnemonic, passphrase } = await walletMnemonic(walletId);
  const nostr = await deriveNostrIdentity(mnemonic, passphrase);
  await loadMlsIndex(nostr.pubkey);
  const targets = Array.from(new Set([...DISCOVERY_RELAYS, ...relays]));
  const evts = await getPool().querySync(
    targets,
    { kinds: [GIFT_WRAP], '#p': [nostr.pubkey] },
    { maxWait: 8000 }
  );
  for (const evt of evts) {
    try {
      await ingestMlsGiftWrap(
        walletId,
        evt,
        onMessage,
        nostr.pubkey,
        nostr.secretKey
      );
    } catch {
      /* not MLS for us */
    }
  }
  const hTags = listMlsGroups().map((g) => g.nostrGroupIdHex);
  if (!hTags.length) return;
  const groups = await getPool().querySync(
    targets,
    { kinds: [KIND_GROUP], '#h': hTags },
    { maxWait: 8000 }
  );
  for (const evt of groups) {
    try {
      await handleGroupEvent(evt, onMessage, nostr.pubkey);
    } catch {
      /* skip */
    }
  }
}

export function subscribeMls(
  walletId: number,
  onMessage: (m: ChatMessage) => void,
  relays: string[] = DEFAULT_RELAYS
): () => void {
  let closed = false;
  const subs: { close: () => void }[] = [];
  void (async () => {
    const { mnemonic, passphrase } = await walletMnemonic(walletId);
    const nostr = await deriveNostrIdentity(mnemonic, passphrase);
    await loadMlsIndex(nostr.pubkey);
    if (closed) return;
    const targets = Array.from(new Set([...DISCOVERY_RELAYS, ...relays]));
    const hTags = listMlsGroups().map((g) => g.nostrGroupIdHex);
    const onEvent = (evt: Event) => {
      void (async () => {
        try {
          if (evt.kind === GIFT_WRAP) {
            await ingestMlsGiftWrap(
              walletId,
              evt,
              onMessage,
              nostr.pubkey,
              nostr.secretKey
            );
            return;
          }
          if (evt.kind === KIND_GROUP) {
            await handleGroupEvent(evt, onMessage, nostr.pubkey);
            return;
          }
          if (evt.kind === KIND_30078) {
            await handlePaytacaEnvelope(evt, onMessage, walletId, nostr.pubkey);
          }
        } catch {
          /* not for us */
        }
      })();
    };
    subs.push(
      getPool().subscribeMany(
        targets,
        { kinds: [GIFT_WRAP], '#p': [nostr.pubkey] },
        { onevent: onEvent }
      )
    );
    subs.push(
      getPool().subscribeMany(
        targets,
        { kinds: [KIND_30078], '#p': [nostr.pubkey] },
        { onevent: onEvent }
      )
    );
    if (hTags.length) {
      subs.push(
        getPool().subscribeMany(
          targets,
          { kinds: [KIND_GROUP], '#h': hTags },
          { onevent: onEvent }
        )
      );
    }
  })();
  return () => {
    closed = true;
    for (const s of subs) s.close();
  };
}
