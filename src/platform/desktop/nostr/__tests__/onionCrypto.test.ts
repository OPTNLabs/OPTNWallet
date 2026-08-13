import { describe, expect, it } from 'vitest';
import * as ecc from 'tiny-secp256k1';

import {
  isEccAvailable,
  onionLayer,
  onionPeel,
  onionUnpad,
  onionUnpadRaw,
  onionWrap,
  encodeAuthorizedOutput,
  decodeAuthorizedOutput,
  ONION_PAD_SIZE,
} from '../onionCrypto';

// Deterministic throwaway scalars. These are test vectors, never wallet keys.
function testPriv(n: number): Uint8Array {
  const b = new Uint8Array(32);
  b[31] = n;
  return b;
}

/**
 * The x-only (32-byte) form, which is what a Nostr pubkey is and therefore what
 * `mixOrder` / `participants` carry — see `validParticipants`' HEX_64 check and
 * `identity.ts`. The wrapper has to lift this back to a point itself.
 */
function xOnlyHex(priv: Uint8Array): string {
  const compressed = ecc.pointFromScalar(priv, true);
  if (!compressed) throw new Error('test key derivation failed');
  return Buffer.from(compressed.slice(1)).toString('hex');
}

/** Y parity of the point, so both branches of the lift get covered. */
function parity(priv: Uint8Array): number {
  const compressed = ecc.pointFromScalar(priv, true);
  if (!compressed) throw new Error('test key derivation failed');
  return compressed[0];
}

describe('onionCrypto', () => {
  it('has a working secp256k1 backend', () => {
    expect(isEccAvailable()).toBe(true);
  });

  it('participant keys really are x-only, 64 hex chars', () => {
    const hex = xOnlyHex(testPriv(1));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips a payload through a three-hop mix order', async () => {
    const privs = [testPriv(11), testPriv(12), testPriv(13)];
    const mixOrder = privs.map(xOnlyHex);

    const addr = '76a914' + '11'.repeat(20) + '88ac';
    const onion = await onionWrap(`${addr}|54321`, mixOrder);

    // Each hop peels exactly one layer, in mix order.
    let blob = onion;
    for (const priv of privs) {
      blob = await onionPeel(blob, priv);
    }

    expect(onionUnpad(blob)).toEqual({ addr, value: 54321 });
  });

  it('round-trips for both even-Y and odd-Y peeler keys', async () => {
    // d.G and (n-d).G share an x-coordinate, so the lift must agree either way.
    // Scan for a key of each parity rather than hard-coding — which parity a
    // given scalar lands on is not something to guess at.
    const candidates = Array.from({ length: 40 }, (_, i) => testPriv(i + 1));
    const even = candidates.find((p) => parity(p) === 0x02);
    const odd = candidates.find((p) => parity(p) === 0x03);
    expect(even, 'needed an even-Y test key').toBeDefined();
    expect(odd, 'needed an odd-Y test key').toBeDefined();

    for (const priv of [even!, odd!]) {
      const wrapped = await onionWrap('addr|7', [xOnlyHex(priv)]);
      const peeled = await onionPeel(wrapped, priv);
      expect(onionUnpad(peeled)).toEqual({ addr: 'addr', value: 7 });
    }
  });

  it('emits eph_pub(33) || iv(12) || ciphertext+tag per layer', async () => {
    const priv = testPriv(21);
    const data = new Uint8Array(ONION_PAD_SIZE);
    const layer = await onionLayer(data, xOnlyHex(priv));

    // 33 + 12 + fixed plaintext + 16 GCM tag
    expect(layer.length).toBe(33 + 12 + ONION_PAD_SIZE + 16);
    expect(layer[0] === 0x02 || layer[0] === 0x03).toBe(true);
  });

  it('refuses to peel with the wrong key instead of returning garbage', async () => {
    const wrapped = await onionWrap('addr|1', [xOnlyHex(testPriv(31))]);
    await expect(onionPeel(wrapped, testPriv(32))).rejects.toThrow();
  });

  it('rejects a payload too large to pad, with a clear message', async () => {
    const oversized = 'a'.repeat(ONION_PAD_SIZE);
    await expect(
      onionWrap(`${oversized}|1`, [xOnlyHex(testPriv(41))])
    ).rejects.toThrow(/too large|exceeds/i);
  });

  it('pads every layer to a fixed size so blobs are indistinguishable', async () => {
    const short = await onionWrap('a|1', [xOnlyHex(testPriv(51))]);
    const long = await onionWrap(`${'b'.repeat(60)}|123456`, [
      xOnlyHex(testPriv(51)),
    ]);
    expect(short.length).toBe(long.length);
  });

  it('round-trips a credential-authorized output inside uniform onion padding', async () => {
    const output = {
      script: '76a914' + '11'.repeat(20) + '88ac',
      value: 99_600,
      credentialSerial: '22'.repeat(32),
      credentialSig: '33'.repeat(64),
      saltCommitment: '44'.repeat(32),
    };
    const encoded = encodeAuthorizedOutput(output);
    expect(new TextEncoder().encode(encoded).length).toBeLessThan(
      ONION_PAD_SIZE
    );
    expect(decodeAuthorizedOutput(encoded)).toEqual(output);

    const wrapped = await onionWrap(encoded, [xOnlyHex(testPriv(61))]);
    const peeled = await onionPeel(wrapped, testPriv(61));
    expect(decodeAuthorizedOutput(onionUnpadRaw(peeled))).toEqual(output);
  });

  it('rejects malformed authorized-output encodings', () => {
    expect(() => decodeAuthorizedOutput('aa|1|' + 'bb'.repeat(32))).toThrow();
    expect(() =>
      decodeAuthorizedOutput(
        `aa|545|${'bb'.repeat(32)}|${'cc'.repeat(64)}|${'dd'.repeat(32)}`
      )
    ).toThrow(/value|dust/i);
  });
});
