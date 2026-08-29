import { describe, expect, it } from 'vitest';
import { unwrapEvent } from 'nostr-tools/nip17';
import { wrapManyEvents as wrapRumor } from 'nostr-tools/nip59';
import {
  appDataUpdateProposalType,
  clientStateDecoder,
  clientStateEncoder,
  createGroup,
  decode,
  encode,
  joinGroup,
  processMessage,
  wireformats,
} from 'ts-mls';
import {
  decodeNostrGroupData,
  encodeNostrGroupData,
  MARMOT_GROUP_DATA_EXT,
} from '../mlsGroupData';
import { deriveNostrIdentity } from '../identity';
import { deriveMlsKeys, MLS_DERIVATION_PATH, mlsDerivationPath } from '../mlsKeys';
import {
  claimExtraMlsDeviceSlot,
  loadMlsDeviceIndex,
  saveMlsDeviceIndex,
} from '../mlsDevice';
import {
  APP_DATA_DICTIONARY_EXT,
  COMP_PROFILE,
  encodeGroupProfile,
  encodeMarmotGroupDictionary,
  encodeQuicVarint,
  makeMarmotAppDataExtension,
} from '../mlsMarmot';
import {
  ACCOUNT_IDENTITY_PROOF_EXT,
  buildKind443,
  buildKind445,
  coalescedMemberPubKeys,
  commitAddMember,
  commitAppDataUpdate,
  decryptKind445Content,
  encryptMlsMessage,
  ensureMlsCrypto,
  generateMlsKeyPackage,
  getMlsGroupMembers,
  innerKind9,
  KIND_GROUP,
  KIND_KEYPACKAGE,
  KIND_WELCOME,
  leafCountForPubkey,
  mlsContext,
  mlsLeafCount,
  parseApplicationPayload,
  PRIVATE_MLS_MAX_MEMBERS,
  readMlsAppData,
  unsignedKind444,
  unsignedMlsRumor,
  verifyLeafAccountIdentityProof,
} from '../mls';


const MNEMONIC_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MNEMONIC_B =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('MLS keys and NIP-EE wire', () => {
  it("derives Ed25519 MLS keys on m/44'/1237'/0'/0/1, not the Nostr identity", async () => {
    const keys = await deriveMlsKeys(MNEMONIC_A);
    const nostr = await deriveNostrIdentity(MNEMONIC_A);
    expect(MLS_DERIVATION_PATH).toBe("m/44'/1237'/0'/0/1");
    expect(keys.privateKey).toHaveLength(32);
    expect(keys.publicKey).toHaveLength(32);
    expect(keys.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.publicKeyHex).not.toBe(nostr.pubkey);
    expect('privateKeyHex' in keys).toBe(false);
    expect(mlsDerivationPath(0)).toBe("m/44'/1237'/0'/0/1");
    expect(mlsDerivationPath(1)).toBe("m/44'/1237'/0'/0/2");
    const other = await deriveMlsKeys(MNEMONIC_A, '', 1);
    expect(other.publicKeyHex).not.toBe(keys.publicKeyHex);
  });

  it('stores an extra-device slot without changing device 0 on other ids', async () => {
    const slotPub = 'cd'.repeat(32);
    expect(await loadMlsDeviceIndex(slotPub)).toBe(0);
    expect(await claimExtraMlsDeviceSlot(slotPub)).toBe(1);
    expect(await loadMlsDeviceIndex(slotPub)).toBe(1);
    expect(await claimExtraMlsDeviceSlot(slotPub)).toBe(1);
    await saveMlsDeviceIndex(slotPub, 2);
    expect(await loadMlsDeviceIndex(slotPub)).toBe(2);
  });

  it('B decrypts an application message A sent (process against B state, not A post-send)', async () => {
    const a = await deriveNostrIdentity(MNEMONIC_A);
    const b = await deriveNostrIdentity(MNEMONIC_B);
    const { impl } = await ensureMlsCrypto();
    const aKp = await generateMlsKeyPackage(a.pubkey, MNEMONIC_A);
    const bKp = await generateMlsKeyPackage(b.pubkey, MNEMONIC_B);
    const groupId = new Uint8Array(32).fill(7);
    const aState = await createGroup({
      context: mlsContext(impl),
      groupId,
      keyPackage: aKp.publicPackage,
      privateKeyPackage: aKp.privatePackage,
    });
    const committed = await commitAddMember(aState, bKp.publicPackage);
    expect(committed.welcome).toBeDefined();
    const bState = await joinGroup({
      context: mlsContext(impl),
      welcome: committed.welcome!.welcome,
      keyPackage: bKp.publicPackage,
      privateKeys: bKp.privatePackage,
    });
    const payload = innerKind9(a.pubkey, 'gm mls');
    const sent = await encryptMlsMessage(
      committed.newState,
      JSON.stringify(payload)
    );
    const processed = await processMessage({
      context: mlsContext(impl),
      state: bState,
      message: sent.message,
    });
    expect(processed.kind).toBe('applicationMessage');
    if (processed.kind === 'applicationMessage') {
      const parsed = parseApplicationPayload(processed.message);
      expect(parsed.text).toBe('gm mls');
      expect(parsed.from).toBe(a.pubkey);
    }
  });

  it('kind 445 is Marmot AEAD (marmot/group-event) and signed by an ephemeral key, not npub', async () => {
    const a = await deriveNostrIdentity(MNEMONIC_A);
    const { impl } = await ensureMlsCrypto();
    const aKp = await generateMlsKeyPackage(a.pubkey, MNEMONIC_A);
    const groupId = crypto.getRandomValues(new Uint8Array(32));
    const nostrGroupId = bytesOrHex32();
    const state = await createGroup({
      context: mlsContext(impl),
      groupId,
      keyPackage: aKp.publicPackage,
      privateKeyPackage: aKp.privatePackage,
    });
    const sent = await encryptMlsMessage(state, 'secret');
    const evt = await buildKind445(sent.newState, sent.message, nostrGroupId);
    expect(evt.kind).toBe(KIND_GROUP);
    expect(evt.pubkey).not.toBe(a.pubkey);
    expect(evt.tags).toEqual([['h', nostrGroupId]]);
    expect(JSON.stringify(evt)).not.toContain('secret');
    expect(JSON.stringify(evt)).not.toContain(bytesToHexLocal(groupId));

    const mlsMsg = await decryptKind445Content(sent.newState, evt.content);
    expect(mlsMsg?.wireformat).toBe(wireformats.mls_private_message);
  });

  it('kind 443 KeyPackage is signed by identity; MLS sign key stays off the event', async () => {
    const a = await deriveNostrIdentity(MNEMONIC_A);
    const kp = await generateMlsKeyPackage(a.pubkey, MNEMONIC_A);
    const evt = buildKind443(kp.publicPackage, a.secretKey, [
      'wss://relay.paytaca.com',
    ]);
    expect(evt.kind).toBe(KIND_KEYPACKAGE);
    expect(evt.pubkey).toBe(a.pubkey);
    expect(evt.tags).toEqual(
      expect.arrayContaining([
        ['mls_protocol_version', '1.0'],
        ['ciphersuite', '0x0001'],
        ['mls_extensions', '0x0006', '0xf2ee', '0x000a', '0xf2f1'],
        ['-'],
      ])
    );
    expect(evt.content).toMatch(/^[0-9a-f]+$/i);
    expect(kp.publicPackage.leafNode.credential.identity).toHaveLength(32);
    expect(
      kp.publicPackage.leafNode.extensions.some(
        (e) => e.extensionType === ACCOUNT_IDENTITY_PROOF_EXT
      )
    ).toBe(true);
    const { impl } = await ensureMlsCrypto();
    verifyLeafAccountIdentityProof(kp.publicPackage.leafNode, impl.id);
  });

  it('kind 444 Welcome is unsigned and gift-wrapped to the invitee', async () => {
    const a = await deriveNostrIdentity(MNEMONIC_A);
    const b = await deriveNostrIdentity(MNEMONIC_B);
    const { impl } = await ensureMlsCrypto();
    const aKp = await generateMlsKeyPackage(a.pubkey, MNEMONIC_A);
    const bKp = await generateMlsKeyPackage(b.pubkey, MNEMONIC_B);
    const aState = await createGroup({
      context: mlsContext(impl),
      groupId: new Uint8Array(32).fill(3),
      keyPackage: aKp.publicPackage,
      privateKeyPackage: aKp.privatePackage,
    });
    const committed = await commitAddMember(aState, bKp.publicPackage);
    const rumor = unsignedKind444(
      a.pubkey,
      committed.welcome!,
      ['wss://relay.paytaca.com']
    );
    expect(rumor.kind).toBe(KIND_WELCOME);
    expect('sig' in rumor).toBe(false);
    const wraps = wrapRumor(rumor, a.secretKey, [b.pubkey]);
    const forB = wraps.find((w) =>
      w.tags.some((t) => t[0] === 'p' && t[1] === b.pubkey)
    )!;
    expect(forB.kind).toBe(1059);
    expect(forB.pubkey).not.toBe(a.pubkey);
    const inner = unwrapEvent(forB, b.secretKey);
    expect(inner.kind).toBe(KIND_WELCOME);
  });

  it('encodes Marmot app_data_dictionary (ext 0x0006) via ts-mls', () => {
    expect(encodeQuicVarint(7)).toEqual(new Uint8Array([7]));
    expect(encodeQuicVarint(64)[0]).toBe(0x40);
    const ext = makeMarmotAppDataExtension({
      name: 'crew',
      description: '',
      adminPubKey: 'ab'.repeat(32),
      nostrGroupId: new Uint8Array(32).fill(3),
      relays: ['wss://relay.paytaca.com'],
    });
    expect(ext.extensionType).toBe(APP_DATA_DICTIONARY_EXT);
    expect(ext.extensionData.length).toBeGreaterThan(32);
    expect(APP_DATA_DICTIONARY_EXT).toBe(0x0006);
    expect(appDataUpdateProposalType).toBe(0x0008);
    const legacy = encodeMarmotGroupDictionary({
      name: 'crew',
      description: '',
      adminPubKey: 'ab'.repeat(32),
      nostrGroupId: new Uint8Array(32).fill(3),
      relays: ['wss://relay.paytaca.com'],
    });
    expect(legacy.length).toBeGreaterThan(32);
  });

  it('encodes nostr_group_data (0xF2EE) and roundtrips', () => {
    const nostrGroupId = new Uint8Array(32).fill(9);
    const bytes = encodeNostrGroupData({
      nostrGroupId,
      name: 'crew',
      description: 'fs private',
      adminPubKeys: ['ab'.repeat(32)],
      relays: ['wss://relay.paytaca.com'],
    });
    expect(bytes[0]).toBe(0);
    expect(bytes[1]).toBe(2);
    const back = decodeNostrGroupData(bytes);
    expect(back?.name).toBe('crew');
    expect(back?.adminPubKeys[0]).toBe('ab'.repeat(32));
    expect(back?.relays).toEqual(['wss://relay.paytaca.com']);
    expect(MARMOT_GROUP_DATA_EXT).toBe(0xf2ee);
  });

  it('persists MLS ratchet via clientStateEncoder', async () => {
    const a = await deriveNostrIdentity(MNEMONIC_A);
    const { impl } = await ensureMlsCrypto();
    const aKp = await generateMlsKeyPackage(a.pubkey, MNEMONIC_A);
    const state = await createGroup({
      context: mlsContext(impl),
      groupId: new Uint8Array(32).fill(4),
      keyPackage: aKp.publicPackage,
      privateKeyPackage: aKp.privatePackage,
    });
    const bytes = encode(clientStateEncoder, state);
    const decoded = decode(clientStateDecoder, bytes);
    expect(decoded).toBeDefined();
    expect(decoded!.groupContext.groupId).toEqual(state.groupContext.groupId);
  });

  it('commits AppDataUpdate 0x0008 and the peer applies it', async () => {
    const a = await deriveNostrIdentity(MNEMONIC_A);
    const b = await deriveNostrIdentity(MNEMONIC_B);
    const { impl } = await ensureMlsCrypto();
    const aKp = await generateMlsKeyPackage(a.pubkey, MNEMONIC_A);
    const bKp = await generateMlsKeyPackage(b.pubkey, MNEMONIC_B);
    const nostrGroupId = new Uint8Array(32).fill(11);
    const aState = await createGroup({
      context: mlsContext(impl),
      groupId: new Uint8Array(32).fill(12),
      keyPackage: aKp.publicPackage,
      privateKeyPackage: aKp.privatePackage,
      extensions: [
        makeMarmotAppDataExtension({
          name: 'before',
          description: '',
          adminPubKey: a.pubkey,
          nostrGroupId,
          relays: ['wss://relay.paytaca.com'],
        }),
      ],
    });
    const added = await commitAddMember(aState, bKp.publicPackage);
    const bState = await joinGroup({
      context: mlsContext(impl),
      welcome: added.welcome!.welcome,
      keyPackage: bKp.publicPackage,
      privateKeys: bKp.privatePackage,
    });
    const renamed = await commitAppDataUpdate(
      added.newState,
      COMP_PROFILE,
      encodeGroupProfile('after', 'renamed')
    );
    const processed = await processMessage({
      context: mlsContext(impl),
      state: bState,
      message: renamed.commit,
    });
    const dict = readMlsAppData(processed.newState);
    const profile = dict?.find((e) => e.componentId === COMP_PROFILE)?.data;
    expect(profile).toBeDefined();
    expect(new TextDecoder().decode(profile!)).toContain('after');
    expect(appDataUpdateProposalType).toBe(8);
  });

  it('private MLS rumor is gift-wrapped; outer 1059 has no group h tag', async () => {
    expect(PRIVATE_MLS_MAX_MEMBERS).toBe(8);
    const a = await deriveNostrIdentity(MNEMONIC_A);
    const b = await deriveNostrIdentity(MNEMONIC_B);
    const { impl } = await ensureMlsCrypto();
    const aKp = await generateMlsKeyPackage(a.pubkey, MNEMONIC_A);
    const state = await createGroup({
      context: mlsContext(impl),
      groupId: new Uint8Array(32).fill(5),
      keyPackage: aKp.publicPackage,
      privateKeyPackage: aKp.privatePackage,
    });
    const sent = await encryptMlsMessage(state, 'hidden');
    const nostrGroupId = 'cc'.repeat(32);
    const rumor = unsignedMlsRumor(a.pubkey, nostrGroupId, sent.message);
    const wraps = wrapRumor(rumor, a.secretKey, [b.pubkey]);
    const outer = wraps.find((w) =>
      w.tags.some((t) => t[0] === 'p' && t[1] === b.pubkey)
    )!;
    expect(outer.kind).toBe(1059);
    expect(outer.tags.some((t) => t[0] === 'h')).toBe(false);
    expect(JSON.stringify(outer)).not.toContain('hidden');
    const inner = unwrapEvent(outer, b.secretKey);
    expect(inner.kind).toBe(KIND_GROUP);
    expect(inner.tags).toEqual([['h', nostrGroupId]]);
  });

  it('binds the MLS leaf sign key to npub with account-identity-proof 0xF2F1', async () => {
    const a = await deriveNostrIdentity(MNEMONIC_A);
    const kp = await generateMlsKeyPackage(a.pubkey, MNEMONIC_A, '', {
      identitySecret: a.secretKey,
    });
    const { impl } = await ensureMlsCrypto();
    verifyLeafAccountIdentityProof(kp.publicPackage.leafNode, impl.id);
    const ext = kp.publicPackage.leafNode.extensions.find(
      (e) => e.extensionType === ACCOUNT_IDENTITY_PROOF_EXT
    );
    expect(ext).toBeDefined();
    const bad = new Uint8Array(ext!.extensionData);
    bad[bad.length - 1] ^= 0xff;
    const tampered = {
      ...kp.publicPackage.leafNode,
      extensions: [{ ...ext!, extensionData: bad }],
    };
    expect(() =>
      verifyLeafAccountIdentityProof(tampered, impl.id)
    ).toThrow();
  });

  it('Adds a same-npub extra device as a second leaf (RFC 9420, not External Commit)', async () => {
    const a = await deriveNostrIdentity(MNEMONIC_A);
    const { impl } = await ensureMlsCrypto();
    const phone = await generateMlsKeyPackage(a.pubkey, MNEMONIC_A, '', {
      deviceIndex: 0,
      identitySecret: a.secretKey,
    });
    const desktop = await generateMlsKeyPackage(a.pubkey, MNEMONIC_A, '', {
      deviceIndex: 1,
      identitySecret: a.secretKey,
    });
    expect(phone.publicPackage.leafNode.signaturePublicKey).not.toEqual(
      desktop.publicPackage.leafNode.signaturePublicKey
    );
    const phoneState = await createGroup({
      context: mlsContext(impl),
      groupId: new Uint8Array(32).fill(21),
      keyPackage: phone.publicPackage,
      privateKeyPackage: phone.privatePackage,
    });
    const committed = await commitAddMember(phoneState, desktop.publicPackage);
    expect(committed.welcome).toBeDefined();
    const desktopState = await joinGroup({
      context: mlsContext(impl),
      welcome: committed.welcome!.welcome,
      keyPackage: desktop.publicPackage,
      privateKeys: desktop.privatePackage,
    });
    expect(mlsLeafCount(committed.newState)).toBe(2);
    expect(leafCountForPubkey(committed.newState, a.pubkey)).toBe(2);
    expect(coalescedMemberPubKeys(committed.newState)).toEqual([a.pubkey]);
    expect(getMlsGroupMembers(desktopState)).toEqual([a.pubkey]);
    verifyLeafAccountIdentityProof(
      phone.publicPackage.leafNode,
      impl.id
    );
    verifyLeafAccountIdentityProof(
      desktop.publicPackage.leafNode,
      impl.id
    );
    const payload = innerKind9(a.pubkey, 'from phone');
    const sent = await encryptMlsMessage(
      committed.newState,
      JSON.stringify(payload)
    );
    const processed = await processMessage({
      context: mlsContext(impl),
      state: desktopState,
      message: sent.message,
    });
    expect(processed.kind).toBe('applicationMessage');
    if (processed.kind === 'applicationMessage') {
      expect(parseApplicationPayload(processed.message).text).toBe('from phone');
    }
  });
});

function bytesOrHex32(): string {
  const id = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHexLocal(id);
}

function bytesToHexLocal(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
