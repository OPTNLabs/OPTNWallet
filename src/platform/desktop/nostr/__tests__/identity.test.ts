import { describe, expect, it } from 'vitest';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { getPublicKey } from 'nostr-tools';
import { deriveNostrIdentity, NOSTR_DERIVATION_PATH } from '../identity';

// A checksum-valid BIP39 mnemonic (the canonical all-zero-entropy one).
const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Expected values, cross-checked against nostr-tools' own NIP-06 implementation.
const EXPECTED_PUBKEY = 'e8bcf3823669444d0b49ad45d65088635d9fd8500a75b5f20b59abefa56a144f';
const EXPECTED_NPUB = 'npub1az708q3kd9zy6z6f44zav5ygvdwelkzspf6mtusttx47lft2z38sghk0w7';

describe('nostr identity (NIP-06)', () => {
  it('uses the NIP-06 derivation path', () => {
    expect(NOSTR_DERIVATION_PATH).toBe("m/44'/1237'/0'/0/0");
  });

  it('matches nostr-tools nip06 exactly (interoperable)', async () => {
    // If our wallet-HD derivation reproduces nostr-tools' own reference for the
    // same mnemonic, our Nostr identity is standard NIP-06 and interoperates
    // with every other Nostr client.
    const refPubkey = getPublicKey(privateKeyFromSeedWords(VALID_MNEMONIC));
    const mine = await deriveNostrIdentity(VALID_MNEMONIC, '');
    expect(mine.pubkey).toBe(refPubkey);
    expect(mine.pubkey).toBe(EXPECTED_PUBKEY);
    expect(mine.npub).toBe(EXPECTED_NPUB);
    expect(mine.secretKey).toHaveLength(32);
  });

  it('is deterministic for the same mnemonic', async () => {
    const a = await deriveNostrIdentity(VALID_MNEMONIC, '');
    const b = await deriveNostrIdentity(VALID_MNEMONIC, '');
    expect(b.pubkey).toBe(a.pubkey);
  });
});
