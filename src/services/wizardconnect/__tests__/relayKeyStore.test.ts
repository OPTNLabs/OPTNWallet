import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256, validateSecp256k1PrivateKey } from '@bitauth/libauth';

import { createDeterministicRuntimePrivateKey } from '../../HdWalletService';
import { binToHex } from '../../../utils/hex';

const URI =
  'wiz://?p=qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7l&s=qpzry9x8';
const QR_URI =
  'WIZ://%3FP%3DQPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L%26S%3DQPZRY9X8';

function stubLocalStorage() {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
  };
  vi.stubGlobal('localStorage', localStorage);
  return { storage, localStorage };
}

describe('WizardConnect relay key store', () => {
  beforeEach(() => {
    stubLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('generates a 32-byte valid secp256k1 private key from CSPRNG', async () => {
    const { generateRuntimeRelayKey } = await import('../relayKeyStore');
    const key = generateRuntimeRelayKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toHaveLength(32);
    expect(validateSecp256k1PrivateKey(key)).toBe(true);
  });

  it('does not derive the relay key from the pairing URI', async () => {
    const { generateRuntimeRelayKey } = await import('../relayKeyStore');
    const key = generateRuntimeRelayKey();
    const uriDerived = createDeterministicRuntimePrivateKey(
      'wizardconnect',
      '1',
      URI
    );
    expect(binToHex(key)).not.toBe(binToHex(uriDerived));
  });

  it('produces a new key on each generate call', async () => {
    const { generateRuntimeRelayKey } = await import('../relayKeyStore');
    const a = generateRuntimeRelayKey();
    const b = generateRuntimeRelayKey();
    expect(binToHex(a)).not.toBe(binToHex(b));
  });

  it('identifies QR and copy-paste URIs as the same pairing without storing the URI', async () => {
    const { pairingIdForUri } = await import('../relayKeyStore');
    const id = pairingIdForUri(URI);
    expect(id).toBe(pairingIdForUri(QR_URI));
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id.includes('qpzry9x8')).toBe(false);
    expect(id).not.toBe(URI);
  });

  it('restores the same key for the same wallet and pairing after reload', async () => {
    const { getOrCreatePersistedRelayKey } = await import('../relayKeyStore');
    const first = await getOrCreatePersistedRelayKey(7, URI);
    vi.resetModules();
    const { getOrCreatePersistedRelayKey: reload } = await import(
      '../relayKeyStore'
    );
    const second = await reload(7, QR_URI);
    expect(binToHex(second)).toBe(binToHex(first));
  });

  it('keeps relay keys isolated per wallet', async () => {
    const { getOrCreatePersistedRelayKey } = await import('../relayKeyStore');
    const walletA = await getOrCreatePersistedRelayKey(1, URI);
    const walletB = await getOrCreatePersistedRelayKey(2, URI);
    expect(binToHex(walletA)).not.toBe(binToHex(walletB));
  });

  it('persists ciphertext, not the raw key or pairing URI', async () => {
    const { storage } = stubLocalStorage();
    const { getOrCreatePersistedRelayKey } = await import('../relayKeyStore');
    const key = await getOrCreatePersistedRelayKey(3, URI);
    const dumped = [...storage.values()].join('\n');
    expect(dumped).not.toContain(binToHex(key));
    expect(dumped).not.toContain(URI);
    expect(dumped).not.toContain('qpzry9x8gf2tvdw0s3jn54khce6mua7l');
    expect(dumped.length).toBeGreaterThan(0);
  });

  it('cannot reconstruct a persisted key from walletId and URI alone', async () => {
    const { getOrCreatePersistedRelayKey } = await import('../relayKeyStore');
    const stored = await getOrCreatePersistedRelayKey(9, URI);
    const guessed = createDeterministicRuntimePrivateKey(
      'wizardconnect',
      '9',
      URI
    );
    expect(binToHex(stored)).not.toBe(binToHex(guessed));
    const material = new TextEncoder().encode(`wizardconnect:9:${URI}:0`);
    expect(binToHex(stored)).not.toBe(binToHex(sha256.hash(material)));
  });
});
