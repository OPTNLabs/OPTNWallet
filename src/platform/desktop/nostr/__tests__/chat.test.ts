import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { wrapManyEvents, unwrapEvent } from 'nostr-tools/nip17';
import { createKind10050, toPubkeyHex } from '../chat';
import { DEFAULT_RELAYS, DISCOVERY_RELAYS, isDefaultNostrRelay } from '../defaultRelays';
import { deriveNostrIdentity } from '../identity';

// Exercises the NIP-17 DM crypto the chat service uses, offline (no relays):
// wrap a message from A to B, and confirm B (and only B) recovers it.
describe('nostr chat DM (NIP-17)', () => {
  it('B recovers a DM A sent; the wrap hides the plaintext', () => {
    const aSk = generateSecretKey();
    const aPk = getPublicKey(aSk);
    const bSk = generateSecretKey();
    const bPk = getPublicKey(bSk);

    // wrapManyEvents -> [self-copy for A, copy for B].
    const wraps = wrapManyEvents(aSk, [{ publicKey: bPk }], 'gm on chipnet');
    expect(wraps).toHaveLength(2);

    // The gift wrap is kind 1059 and leaks neither sender nor plaintext.
    for (const w of wraps) {
      expect(w.kind).toBe(1059);
      expect(JSON.stringify(w)).not.toContain('gm on chipnet');
      expect(w.pubkey).not.toBe(aPk); // wrapped under an ephemeral key
    }

    // B's copy is the one tagged to B; unwrap it.
    const forB = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === bPk))!;
    const rumor = unwrapEvent(forB, bSk);
    expect(rumor.content).toBe('gm on chipnet');
    expect(rumor.pubkey).toBe(aPk); // real sender revealed only after decryption

    // A's self-copy round-trips under A's key too.
    const forA = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === aPk))!;
    expect(unwrapEvent(forA, aSk).content).toBe('gm on chipnet');
  });

  it('mobile and desktop identities exchange NIP-17 DMs in both directions', async () => {
    // These identities stand in for separate mobile and desktop wallet clients.
    // Both clients use the same NIP-06 derivation path and NIP-17 wire format.
    const mobile = await deriveNostrIdentity(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    const desktop = await deriveNostrIdentity(
      'legal winner thank year wave sausage worth useful legal winner thank yellow'
    );

    expect(toPubkeyHex(desktop.npub)).toBe(desktop.pubkey);
    expect(toPubkeyHex(mobile.npub)).toBe(mobile.pubkey);

    const mobileToDesktop = wrapManyEvents(
      mobile.secretKey,
      [{ publicKey: desktop.pubkey }],
      'hello from mobile'
    );
    const desktopCopy = mobileToDesktop.find((event) =>
      event.tags.some((tag) => tag[0] === 'p' && tag[1] === desktop.pubkey)
    );
    expect(desktopCopy).toBeDefined();
    expect(unwrapEvent(desktopCopy!, desktop.secretKey)).toMatchObject({
      content: 'hello from mobile',
      pubkey: mobile.pubkey,
    });

    const desktopToMobile = wrapManyEvents(
      desktop.secretKey,
      [{ publicKey: mobile.pubkey }],
      'hello from desktop'
    );
    const mobileCopy = desktopToMobile.find((event) =>
      event.tags.some((tag) => tag[0] === 'p' && tag[1] === mobile.pubkey)
    );
    expect(mobileCopy).toBeDefined();
    expect(unwrapEvent(mobileCopy!, mobile.secretKey)).toMatchObject({
      content: 'hello from desktop',
      pubkey: desktop.pubkey,
    });
  });

  it('uses DISCOVERY_RELAYS and createKind10050', () => {
    expect(DISCOVERY_RELAYS).toEqual(['wss://relay.paytaca.com']);
    expect(DEFAULT_RELAYS.slice(0, 8)).not.toContain('wss://relay.paytaca.com');
    expect(DEFAULT_RELAYS).toContain('wss://relay.paytaca.com');
    expect(isDefaultNostrRelay('wss://relay.paytaca.com/')).toBe(true);

    const sk = generateSecretKey();
    const evt = createKind10050([...DISCOVERY_RELAYS], sk);
    expect(evt.kind).toBe(10050);
    expect(evt.tags).toEqual([['relay', 'wss://relay.paytaca.com']]);
  });

  it('toPubkeyHex accepts npub and hex, rejects junk', () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    expect(toPubkeyHex(pk)).toBe(pk);
    // The tip target from the user: a real npub decodes to 64-hex.
    expect(toPubkeyHex('npub10gp4r5svjlwphe8rz3tt0w6t8z042md3adtreyx8wgpdxyj8vxgqfhl65t')).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(() => toPubkeyHex('not-a-key')).toThrow();
  });
});
