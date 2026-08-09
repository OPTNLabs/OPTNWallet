import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';

import {
  componentBlindMessageHash,
  componentBlindMessageHashHex,
  encodeInputComponent,
  EC_INPUT_COMPONENT_GOLDEN_HEX,
  P2P_COMPONENT_PROTOCOL,
  ROUND_MSG_VERSION_V4,
} from '../fusionComponentV4';
import { ROUND_MSG_VERSION } from '../fusionRound';

describe('P2P v4 EC component plane', () => {
  it('activates wire v4', () => {
    expect(ROUND_MSG_VERSION).toBe(4);
    expect(ROUND_MSG_VERSION_V4).toBe(4);
    expect(P2P_COMPONENT_PROTOCOL).toBe('p2p-v4-ec-component');
  });

  it('encode matches Electron Cash input component golden vector', () => {
    const bytes = encodeInputComponent({
      prevTxidDisplayHex: 'aa'.repeat(32),
      prevIndex: 3,
      pubkeyHex: '02'.repeat(33),
      amount: 200_000,
      saltCommitmentHex: '11'.repeat(32),
    });
    expect(binToHex(bytes)).toBe(EC_INPUT_COMPONENT_GOLDEN_HEX);
  });

  it('blind message is sha256(component), not a v3 domain string', () => {
    const component = hexToBin(EC_INPUT_COMPONENT_GOLDEN_HEX);
    const msg = componentBlindMessageHash(component);
    const expected = new Uint8Array(sha256.hash(component));
    expect(binToHex(msg)).toBe(binToHex(expected));
    expect(componentBlindMessageHashHex(EC_INPUT_COMPONENT_GOLDEN_HEX)).toBe(
      binToHex(expected)
    );

    const v3Style = new TextEncoder().encode(
      `optn-p2p-input-v1|${'aa'.repeat(32)}|3|200000|${'02'.repeat(33)}`
    );
    expect(binToHex(msg)).not.toBe(binToHex(sha256.hash(v3Style)));
  });

  it('rejects empty component bytes', () => {
    expect(() => componentBlindMessageHash(new Uint8Array())).toThrow(
      /non-empty/
    );
  });
});
