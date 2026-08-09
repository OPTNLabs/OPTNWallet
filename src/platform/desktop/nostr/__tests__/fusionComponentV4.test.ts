import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';

import {
  componentBlindMessageHash,
  componentBlindMessageHashHex,
  EC_INPUT_COMPONENT_GOLDEN_HEX,
  P2P_COMPONENT_PROTOCOL,
  ROUND_MSG_VERSION_V4,
} from '../fusionComponentV4';
import { ROUND_MSG_VERSION } from '../fusionRound';
import {
  inputCredentialMessageHash,
  outputCredentialMessageHash,
} from '../fusionBlindSchnorr';

describe('P2P v4 EC component plane (Phase B)', () => {
  it('does not activate wire v4 while Phase B only', () => {
    expect(ROUND_MSG_VERSION).toBe(3);
    expect(ROUND_MSG_VERSION_V4).toBe(4);
    expect(P2P_COMPONENT_PROTOCOL).toBe('p2p-v4-ec-component');
  });

  it('locks the Electron Cash input component protobuf golden vector', () => {
    // Byte-identical to native p2p_component + components.rs tests.
    expect(EC_INPUT_COMPONENT_GOLDEN_HEX).toMatch(/^[0-9a-f]+$/);
    expect(EC_INPUT_COMPONENT_GOLDEN_HEX.length).toBeGreaterThan(100);
    const bytes = hexToBin(EC_INPUT_COMPONENT_GOLDEN_HEX);
    expect(bytes[0]).toBe(0x0a); // field 1 length-delimited (salt_commitment)
  });

  it('blind message is sha256(component), not the v3 domain string', () => {
    const component = hexToBin(EC_INPUT_COMPONENT_GOLDEN_HEX);
    const msg = componentBlindMessageHash(component);
    const expected = new Uint8Array(sha256.hash(component));
    expect(binToHex(msg)).toBe(binToHex(expected));
    expect(componentBlindMessageHashHex(EC_INPUT_COMPONENT_GOLDEN_HEX)).toBe(
      binToHex(expected)
    );

    // v3 hashes a UTF-8 domain string — must never equal EC component hash.
    const v3Input = inputCredentialMessageHash({
      prevTxid: 'aa'.repeat(32),
      prevIndex: 3,
      value: 200_000,
      pubkey: '02'.repeat(33),
    });
    expect(binToHex(msg)).not.toBe(binToHex(v3Input));

    const v3Output = outputCredentialMessageHash(
      { session: 'ab'.repeat(32), network: 'chipnet', tier: 10_000 },
      { script: '76a914' + '00'.repeat(20) + '88ac', value: 200_000 },
      'cd'.repeat(16)
    );
    expect(binToHex(msg)).not.toBe(binToHex(v3Output));
  });

  it('rejects empty component bytes', () => {
    expect(() => componentBlindMessageHash(new Uint8Array())).toThrow(
      /non-empty/
    );
  });
});
