// Marmot / NIP-EE group-data MLS extension (0xF2EE).
// Fields from NIP-EE; version-u16 prefix matches MDK v2/v3 dispatch.

export const MARMOT_GROUP_DATA_EXT = 0xf2ee;
export const NOSTR_GROUP_DATA_VERSION = 2;

export type NostrGroupData = {
  nostrGroupId: Uint8Array;
  name: string;
  description: string;
  adminPubKeys: string[];
  relays: string[];
};

function u16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
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

function opaque16(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0xffff) throw new Error('opaque16 too long');
  return concat([u16(bytes.length), bytes]);
}

function vec16(items: Uint8Array[]): Uint8Array {
  return concat([u16(items.length), ...items]);
}

export function encodeNostrGroupData(data: NostrGroupData): Uint8Array {
  if (data.nostrGroupId.length !== 32) {
    throw new Error('nostr_group_id must be 32 bytes');
  }
  const utf8 = new TextEncoder();
  const admins = data.adminPubKeys.map((hex) => {
    const raw = hex.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(raw))
      throw new Error('admin pubkey must be 32-byte hex');
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
      b[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
    return opaque16(b);
  });
  const relays = data.relays.map((url) => opaque16(utf8.encode(url)));
  return concat([
    u16(NOSTR_GROUP_DATA_VERSION),
    data.nostrGroupId,
    opaque16(utf8.encode(data.name)),
    opaque16(utf8.encode(data.description)),
    vec16(admins),
    vec16(relays),
  ]);
}

export function decodeNostrGroupData(bytes: Uint8Array): NostrGroupData | null {
  try {
    let i = 0;
    const take = (n: number) => {
      if (i + n > bytes.length) throw new Error('short');
      const s = bytes.subarray(i, i + n);
      i += n;
      return s;
    };
    const takeU16 = () => {
      const b = take(2);
      return (b[0] << 8) | b[1];
    };
    const takeOpaque = () => take(takeU16());
    const version = takeU16();
    if (version < 1 || version > 3) return null;
    const nostrGroupId = new Uint8Array(take(32));
    const utf8 = new TextDecoder();
    const name = utf8.decode(takeOpaque());
    const description = utf8.decode(takeOpaque());
    const adminN = takeU16();
    const adminPubKeys: string[] = [];
    for (let n = 0; n < adminN; n++) {
      const id = takeOpaque();
      adminPubKeys.push(
        Array.from(id)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
      );
    }
    const relayN = takeU16();
    const relays: string[] = [];
    for (let n = 0; n < relayN; n++) relays.push(utf8.decode(takeOpaque()));
    return { nostrGroupId, name, description, adminPubKeys, relays };
  } catch {
    return null;
  }
}
