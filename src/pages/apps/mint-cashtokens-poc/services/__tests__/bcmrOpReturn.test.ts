import { describe, expect, it } from 'vitest';

import { sha256 } from '../../../../../utils/hash';
import { binToHex } from '../../../../../utils/hex';
import {
  buildBcmrPublicationOpReturn,
  parseUrisInput,
} from '../bcmrOpReturn';

describe('bcmrOpReturn', () => {
  it('builds BCMR OP_RETURN chunks with sha256 hash bytes', () => {
    const out = buildBcmrPublicationOpReturn({
      registryJson: '{"name":"demo"}',
      uris: ['ipfs://bafy123'],
    });

    expect(out.opReturn[0]).toBe('BCMR');
    expect(out.opReturn[1].startsWith('0x')).toBe(true);
    expect(out.opReturn[2]).toBe('ipfs://bafy123');
    expect(out.hashHex).toHaveLength(64);
    expect(out.scriptHex.startsWith('6a0442434d5220')).toBe(true);
    expect(out.scriptHex.includes(out.hashHex)).toBe(true);
  });

  it('throws when registry JSON is empty', () => {
    expect(() =>
      buildBcmrPublicationOpReturn({
        registryJson: '   ',
        uris: ['ipfs://bafy123'],
      })
    ).toThrow('Registry JSON is required');
  });

  it('throws when no URIs are provided', () => {
    expect(() =>
      buildBcmrPublicationOpReturn({
        registryJson: '{"name":"demo"}',
        uris: [],
      })
    ).toThrow('At least one BCMR registry URI is required.');
  });

  it('parses URI input by line', () => {
    expect(parseUrisInput('ipfs://a\n\nexample.com\n')).toEqual([
      'ipfs://a',
      'example.com',
    ]);
  });

  it('hashes exact registry bytes (no implicit trimming)', () => {
    const registryJson = '{"name":"demo"}\n';
    const out = buildBcmrPublicationOpReturn({
      registryJson,
      uris: ['ipfs://bafy123'],
    });
    const expectedHash = binToHex(sha256.hash(new TextEncoder().encode(registryJson)));

    expect(out.hashHex).toBe(expectedHash);
  });
});
