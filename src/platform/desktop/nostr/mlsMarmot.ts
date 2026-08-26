// Marmot component *payloads* (QUIC varints). The 0x0006 dictionary *container*
// is owned by ts-mls (makeAppDataDictionaryExtension) so AppDataUpdate 0x0008
// can mutate it in the MLS transcript.
// Component ids: https://github.com/marmot-protocol/marmot/blob/master/foundation/registries.md

import {
  appDataDictionaryExtensionType,
  makeAppDataDictionaryExtension,
  type ComponentData,
  type CustomExtension,
} from 'ts-mls';

export const APP_DATA_DICTIONARY_EXT = appDataDictionaryExtensionType;
export const COMP_APP_COMPONENTS = 0x0001;
export const COMP_PROFILE = 0x8001;
export const COMP_ADMIN_POLICY = 0x8003;
export const COMP_NOSTR_ROUTING = 0x8004;
export const COMP_LIFECYCLE = 0x800c;
export const KIND_KEYPACKAGE_MARMOT = 30443;
export const LAST_RESORT_EXT = 10;

export function encodeQuicVarint(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error('quic varint');
  if (n < 64) return new Uint8Array([n]);
  if (n < 16384) return new Uint8Array([0x40 | (n >> 8), n & 0xff]);
  if (n >= 1073741824) throw new Error('quic varint too large');
  return new Uint8Array([
    0x80 | ((n >> 24) & 0x3f),
    (n >> 16) & 0xff,
    (n >> 8) & 0xff,
    n & 0xff,
  ]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function marmotOpaque(bytes: Uint8Array): Uint8Array {
  return concat([encodeQuicVarint(bytes.length), bytes]);
}

function marmotVector(items: Uint8Array[]): Uint8Array {
  const body = concat(items);
  return concat([encodeQuicVarint(body.length), body]);
}

function u16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function hexTo32(hex: string): Uint8Array {
  const raw = hex.toLowerCase();
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return b;
}

export function encodeGroupProfile(name: string, description: string): Uint8Array {
  const utf8 = new TextEncoder();
  return concat([
    marmotOpaque(utf8.encode(name)),
    marmotOpaque(utf8.encode(description)),
  ]);
}

export function encodeAdminPolicy(adminPubKeys: string[]): Uint8Array {
  const keys = [...adminPubKeys].map(hexTo32).sort((a, b) => {
    for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
  return marmotVector(keys);
}

export function encodeNostrRouting(
  nostrGroupId: Uint8Array,
  relays: string[]
): Uint8Array {
  const utf8 = new TextEncoder();
  const sorted = [...relays].sort();
  const relayItems = sorted.map((url) => marmotOpaque(utf8.encode(url)));
  return concat([nostrGroupId, marmotVector(relayItems)]);
}

export function encodeLifecycleActive(): Uint8Array {
  return new Uint8Array([0x00]);
}

function encodeAppComponents(ids: number[]): Uint8Array {
  const sorted = [...ids].sort((a, b) => a - b);
  const body = concat(sorted.map(u16));
  return concat([u16(body.length), body]);
}

function dictionaryEntry(id: number, data: Uint8Array): Uint8Array {
  return concat([u16(id), u16(data.length), data]);
}

export function encodeAppDataDictionary(entries: { id: number; data: Uint8Array }[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const body = concat(sorted.map((e) => dictionaryEntry(e.id, e.data)));
  return concat([u16(body.length), body]);
}

export function marmotAppDataEntries(opts: {
  name: string;
  description: string;
  adminPubKey: string;
  nostrGroupId: Uint8Array;
  relays: string[];
}): ComponentData[] {
  const required = [
    COMP_APP_COMPONENTS,
    COMP_ADMIN_POLICY,
    COMP_NOSTR_ROUTING,
    COMP_LIFECYCLE,
    COMP_PROFILE,
  ];
  return [
    { componentId: COMP_APP_COMPONENTS, data: encodeAppComponents(required) },
    { componentId: COMP_PROFILE, data: encodeGroupProfile(opts.name, opts.description) },
    { componentId: COMP_ADMIN_POLICY, data: encodeAdminPolicy([opts.adminPubKey]) },
    {
      componentId: COMP_NOSTR_ROUTING,
      data: encodeNostrRouting(opts.nostrGroupId, opts.relays),
    },
    { componentId: COMP_LIFECYCLE, data: encodeLifecycleActive() },
  ].sort((a, b) => a.componentId - b.componentId);
}

export function makeMarmotAppDataExtension(opts: {
  name: string;
  description: string;
  adminPubKey: string;
  nostrGroupId: Uint8Array;
  relays: string[];
}): CustomExtension {
  return makeAppDataDictionaryExtension(marmotAppDataEntries(opts));
}

/** @deprecated opaque u16-length dictionary; use makeMarmotAppDataExtension */
export function encodeMarmotGroupDictionary(opts: {
  name: string;
  description: string;
  adminPubKey: string;
  nostrGroupId: Uint8Array;
  relays: string[];
}): Uint8Array {
  const required = [
    COMP_APP_COMPONENTS,
    COMP_ADMIN_POLICY,
    COMP_NOSTR_ROUTING,
    COMP_LIFECYCLE,
    COMP_PROFILE,
  ];
  return encodeAppDataDictionary([
    { id: COMP_APP_COMPONENTS, data: encodeAppComponents(required) },
    { id: COMP_PROFILE, data: encodeGroupProfile(opts.name, opts.description) },
    { id: COMP_ADMIN_POLICY, data: encodeAdminPolicy([opts.adminPubKey]) },
    {
      id: COMP_NOSTR_ROUTING,
      data: encodeNostrRouting(opts.nostrGroupId, opts.relays),
    },
    { id: COMP_LIFECYCLE, data: encodeLifecycleActive() },
  ]);
}
