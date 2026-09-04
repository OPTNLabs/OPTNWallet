import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clientStateEncoder, createGroup, encode } from 'ts-mls';
import { wrapManyEvents as wrapRumor } from 'nostr-tools/nip59';

const { storage } = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
}));

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => storage.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    storage.set(key, value);
  }),
}));

const encodeText = (value: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)));
const decodeText = (value: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
  );
const encodeBytes = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const decodeBytes = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const PREFIX = 'enc:test:';

vi.mock('../../../../services/SecretCryptoService', () => ({
  default: {
    encryptText: vi.fn(async (value: string) => PREFIX + encodeText(value)),
    decryptText: vi.fn(async (value: string) =>
      value.startsWith(PREFIX) ? decodeText(value.slice(PREFIX.length)) : value
    ),
    encryptBytes: vi.fn(
      async (value: Uint8Array) => PREFIX + encodeBytes(value)
    ),
    decryptBytes: vi.fn(async (value: string) =>
      value.startsWith(PREFIX)
        ? decodeBytes(value.slice(PREFIX.length))
        : decodeBytes(value)
    ),
  },
}));

import {
  loadLastRead,
  loadStoredMessages,
  storeLastRead,
  storeMessages,
  type ChatMessage,
} from '../chat';
import {
  ensureMlsCrypto,
  generateMlsKeyPackage,
  ingestMlsGiftWrap,
  listMlsGroups,
  loadMlsIndex,
  mlsContext,
  saveMlsState,
  type MlsGroupRecord,
} from '../mls';
import { saveMlsKeyPackage } from '../mlsDevice';
import { deriveNostrIdentity } from '../identity';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('Nostr and MLS persistence security', () => {
  beforeEach(() => storage.clear());

  it('encrypts chat history and read metadata before IndexedDB', async () => {
    const owner = '11'.repeat(32);
    const peer = '22'.repeat(32);
    const messages: ChatMessage[] = [
      {
        id: 'event-1',
        from: peer,
        to: [owner],
        text: 'private chat plaintext',
        at: 1,
        mine: false,
      },
    ];

    await storeMessages(owner, messages);
    await storeLastRead(owner, { [peer]: 123 });

    const storedMessages = storage.get(`nostr-chat:${owner}`);
    const storedRead = storage.get(`nostr-chat-read:${owner}`);
    expect(storedMessages).toEqual(expect.stringMatching(/^enc:test:/));
    expect(storedRead).toEqual(expect.stringMatching(/^enc:test:/));
    expect(String(storedMessages)).not.toContain('private chat plaintext');
    expect(String(storedRead)).not.toContain(peer);
    await expect(loadStoredMessages(owner)).resolves.toEqual(messages);
    await expect(loadLastRead(owner)).resolves.toEqual({ [peer]: 123 });
  });

  it('encrypts MLS private packages and ratchet state before IndexedDB', async () => {
    const identity = await deriveNostrIdentity(MNEMONIC);
    const keyPackage = await generateMlsKeyPackage(identity.pubkey, MNEMONIC);
    await saveMlsKeyPackage(
      identity.pubkey,
      0,
      keyPackage.publicPackage,
      keyPackage.privatePackage
    );

    const storedPackage = storage.get(`nostr-mls-kp:${identity.pubkey}:0`) as
      | Record<string, unknown>
      | undefined;
    expect(storedPackage?.privateEnc).toEqual(
      expect.stringMatching(/^enc:test:/)
    );
    expect(storedPackage).not.toHaveProperty('privateB64');

    const { impl } = await ensureMlsCrypto();
    const state = await createGroup({
      context: mlsContext(impl),
      groupId: new Uint8Array(32).fill(7),
      keyPackage: keyPackage.publicPackage,
      privateKeyPackage: keyPackage.privatePackage,
    });
    const handle = '33'.repeat(32);
    await saveMlsState(handle, state, identity.pubkey);
    expect(
      storage.get(`nostr-mls-ratchet:${identity.pubkey}:${handle}`)
    ).toEqual(expect.stringMatching(/^enc:test:/));

    const remoteHandle = '44'.repeat(32);
    const backup = {
      kind: 30078,
      pubkey: identity.pubkey,
      created_at: 1,
      content: encodeBytes(encode(clientStateEncoder, state)),
      tags: [['d', `optn:mls-backup:${remoteHandle}`]],
    };
    const wrapped = wrapRumor(backup, identity.secretKey, [
      identity.pubkey,
    ])[0]!;
    await ingestMlsGiftWrap(
      1,
      wrapped,
      () => undefined,
      identity.pubkey,
      identity.secretKey
    );
    expect(
      storage.get(`nostr-mls-ratchet:${identity.pubkey}:${remoteHandle}`)
    ).toEqual(expect.stringMatching(/^enc:test:/));
  });

  it('encrypts and scopes the group index to its owning wallet', async () => {
    const ownerA = 'aa'.repeat(32);
    const ownerB = 'bb'.repeat(32);
    const record = (ownerPubKey: string, suffix: string): MlsGroupRecord => ({
      nostrGroupIdHex: suffix.repeat(64),
      mlsGroupIdHex: suffix.repeat(64),
      roomId: suffix.repeat(64),
      wire: 'nip-ee',
      visibility: 'private',
      name: `private-${suffix}`,
      paytacaDual: false,
      memberPubKeys: [ownerPubKey],
      ownerPubKey,
    });
    storage.set(
      `nostr-mls-index:${ownerA}`,
      PREFIX + encodeText(JSON.stringify([record(ownerA, '1')]))
    );
    storage.set(
      `nostr-mls-index:${ownerB}`,
      PREFIX + encodeText(JSON.stringify([record(ownerB, '2')]))
    );

    await expect(loadMlsIndex(ownerA)).resolves.toHaveLength(1);
    expect(listMlsGroups(ownerA).map((group) => group.ownerPubKey)).toEqual([
      ownerA,
    ]);
    await expect(loadMlsIndex(ownerB)).resolves.toHaveLength(1);
    expect(listMlsGroups(ownerA)).toEqual([]);
    expect(listMlsGroups(ownerB).map((group) => group.ownerPubKey)).toEqual([
      ownerB,
    ]);
  });
});
