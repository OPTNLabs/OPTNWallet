import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { bytesToHex } from '@noble/hashes/utils';
import { encode, keyPackageEncoder, makeKeyPackageRef } from 'ts-mls';
import { deriveNostrIdentity } from '../identity';
import {
  buildKind443,
  buildKind30443Mip00,
  bytesToB64,
  ensureMlsCrypto,
  generateMlsKeyPackage,
  keyPackageFromEvent,
  mip00Slot,
  mlsContentBytes,
} from '../mls';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const tag = (tags: string[][], name: string) =>
  tags.find((entry) => entry[0] === name);

describe('ts-mls key packages in MIP-00 form', () => {
  it('carries the bare key package in base64 with the tags MDK requires', async () => {
    const nostr = await deriveNostrIdentity(MNEMONIC);
    const { publicPackage } = await generateMlsKeyPackage(
      nostr.pubkey,
      MNEMONIC,
      '',
      { identitySecret: nostr.secretKey }
    );
    const event = await buildKind30443Mip00(
      publicPackage,
      nostr.secretKey,
      ['wss://relay.example.org'],
      0
    );
    // An opt-in hand-off to MDK's own parser (crates/optn-chat/tests).
    if (process.env.OPTN_MIP00_OUT) {
      writeFileSync(process.env.OPTN_MIP00_OUT, JSON.stringify(event));
    }

    expect(event.kind).toBe(30443);
    expect(tag(event.tags, 'd')?.[1]).toBe(mip00Slot(nostr.pubkey, 0));
    expect(tag(event.tags, 'd')?.[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(tag(event.tags, 'mls_protocol_version')).toEqual([
      'mls_protocol_version',
      '1.0',
    ]);
    expect(tag(event.tags, 'mls_ciphersuite')).toEqual([
      'mls_ciphersuite',
      '0x0001',
    ]);
    expect(tag(event.tags, 'mls_extensions')).toEqual(
      expect.arrayContaining(['0xf2ee', '0x000a'])
    );
    expect(tag(event.tags, 'mls_proposals')).toEqual([
      'mls_proposals',
      '0x000a',
    ]);
    expect(tag(event.tags, 'encoding')).toEqual(['encoding', 'base64']);
    expect(tag(event.tags, 'relays')).toEqual([
      'relays',
      'wss://relay.example.org',
    ]);
    const { impl } = await ensureMlsCrypto();
    expect(tag(event.tags, 'i')?.[1]).toBe(
      bytesToHex(await makeKeyPackageRef(publicPackage, impl.hash))
    );
    expect(event.content).toBe(
      bytesToB64(encode(keyPackageEncoder, publicPackage))
    );

    // Read back as any client publishes it: MIP-00 and the first form.
    const read = keyPackageFromEvent(event);
    expect(read && encode(keyPackageEncoder, read)).toEqual(
      encode(keyPackageEncoder, publicPackage)
    );
    const first = buildKind443(publicPackage, nostr.secretKey, [
      'wss://relay.example.org',
    ]);
    const readFirst = keyPackageFromEvent(first);
    expect(readFirst && encode(keyPackageEncoder, readFirst)).toEqual(
      encode(keyPackageEncoder, publicPackage)
    );
  });

  it('reads MLS bytes by the encoding tag', () => {
    const bytes = new Uint8Array([1, 2, 254]);
    expect(
      mlsContentBytes({
        content: bytesToB64(bytes),
        tags: [['encoding', 'base64']],
      })
    ).toEqual(bytes);
    expect(mlsContentBytes({ content: '0102fe', tags: [] })).toEqual(bytes);
  });

  it('keeps one slot per device', () => {
    const pubkey = 'a'.repeat(64);
    expect(mip00Slot(pubkey, 0)).toBe(mip00Slot(pubkey, 0));
    expect(mip00Slot(pubkey, 0)).not.toBe(mip00Slot(pubkey, 1));
  });
});
