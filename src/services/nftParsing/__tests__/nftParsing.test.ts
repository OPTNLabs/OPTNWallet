import { describe, expect, it } from 'vitest';

import {
  isMinimalVmNumberEncoding,
  lookupSequentialNftType,
  minimallyEncodeVmNumber,
  nftTickerSymbol,
  parseNftCommitment,
  type NftParseInfo,
} from '../nftParsing';

const PLEDGE_PARSE_INFO: NftParseInfo = {
  bytecode: '006b00cf6b',
  types: {
    '': {
      name: 'Pledge Receipt',
      description: 'Receipts issued by the crowdfunding campaign.',
      fields: ['pledgeValue'],
    },
  },
  fields: {
    pledgeValue: {
      name: 'Pledge Value',
      encoding: { type: 'number', aggregate: 'add', decimals: 8, unit: 'BCH' },
    },
  },
};

describe('parseNftCommitment (parsable NFTs)', () => {
  it('parses the chip-bcmr decentralized-application example', () => {
    const result = parseNftCommitment(
      { commitment: '00e1f505' },
      PLEDGE_PARSE_INFO
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.nftTypeKey).toBe('');
    expect(result.nftTypeName).toBe('Pledge Receipt');
    expect(result.nftTypeDescription).toBe(
      'Receipts issued by the crowdfunding campaign.'
    );
    expect(result.fields).toHaveLength(1);
    const field = result.fields[0];
    expect(field.fieldId).toBe('pledgeValue');
    expect(field.name).toBe('Pledge Value');
    expect(field.value).toBe('00e1f505');
    expect(field.parsedValue).toMatchObject({
      type: 'number',
      value: 100_000_000n,
      formatted: '1 BCH',
      decimals: 8,
      unit: 'BCH',
      aggregate: 'add',
    });
  });

  it('parses the canonical split bytecode example', () => {
    // The parsing transaction's unlocking OP_1 is prepended to the main
    // stack, so the draft bytecode 00d2517f7c6b (single OP_TOALTSTACK)
    // leaves a second item behind and fails libauth's clean-stack rule.
    // The doubled OP_TOALTSTACK form is the valid canonical shape.
    const parseInfo: NftParseInfo = {
      bytecode: '00cf517f7c6b6b',
      types: {
        '01': { name: 'Traits', fields: ['value'] },
      },
      fields: {
        value: { name: 'Value', encoding: { type: 'number' } },
      },
    };

    const result = parseNftCommitment({ commitment: '012a' }, parseInfo);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.nftTypeKey).toBe('01');
    expect(result.nftTypeName).toBe('Traits');
    expect(result.altstackHex).toEqual(['01', '2a']);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]?.parsedValue).toMatchObject({
      type: 'number',
      value: 42n,
      formatted: '42',
    });
  });

  it('fails clean-stack check on the draft single-OP_TOALTSTACK form', () => {
    const result = parseNftCommitment(
      { commitment: '012a' },
      {
        bytecode: '00cf517f7c6b',
        types: { '01': { name: 'Traits' } },
      }
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('VM evaluation failed');
    expect(result.error).toContain(
      'unexpected number of items on the stack'
    );
  });

  it('fails when the type key has no matching definition', () => {
    const result = parseNftCommitment(
      { commitment: '00e1f505' },
      { bytecode: '006b00cf6b', types: { '02': { name: 'Other' } } }
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('No NFT type definition');
  });

  it('fails on invalid commitment hex', () => {
    const result = parseNftCommitment(
      { commitment: 'xyz' },
      PLEDGE_PARSE_INFO
    );
    expect(result.success).toBe(false);
  });

  it('fails on invalid or empty parse bytecode', () => {
    expect(
      parseNftCommitment(
        { commitment: '00e1f505' },
        { bytecode: 'zz', types: {} }
      ).success
    ).toBe(false);
    expect(
      parseNftCommitment(
        { commitment: '00e1f505' },
        { bytecode: '', types: {} }
      ).success
    ).toBe(false);
  });

  it('fails on malformed bytecode at the VM level', () => {
    const result = parseNftCommitment(
      { commitment: '00e1f505' },
      { bytecode: '00cf517f', types: { '': { name: 'X' } } }
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('VM evaluation failed');
  });

  it('decodes every supported field encoding', () => {
    const cases: Array<{ value: string; encoding: NftParseInfo['fields'] extends never ? never : NftParseInfo['fields'] }> = [
      {
        value: '6869',
        encoding: { f: { encoding: { type: 'utf8' } } },
        expected: { type: 'utf8', formatted: 'hi' },
      },
      {
        value: 'abcd',
        encoding: { f: { encoding: { type: 'hex' } } },
        expected: { type: 'hex', formatted: '0xabcd' },
      },
      {
        value: '05',
        encoding: { f: { encoding: { type: 'binary' } } },
        expected: { type: 'binary', formatted: '0b00000101' },
      },
      {
        value: '',
        encoding: { f: { encoding: { type: 'binary' } } },
        expected: { type: 'binary', formatted: '0b0' },
      },
      {
        value: '6578616d706c652e636f6d',
        encoding: { f: { encoding: { type: 'https-url' } } },
        expected: {
          type: 'https-url',
          url: 'https://example.com',
        },
      },
      {
        value: '6578616d706c652e636f6d2f6125323062',
        encoding: { f: { encoding: { type: 'https-url' } } },
        expected: {
          type: 'https-url',
          url: 'https://example.com/a b',
        },
      },
      {
        value: '516d593251326747336a50424e',
        encoding: { f: { encoding: { type: 'ipfs-cid' } } },
        expected: { type: 'ipfs-cid', formatted: 'ipfs://QmY2Q2gG3jPBN' },
      },
      {
        value: '01',
        encoding: { f: { encoding: { type: 'boolean' } } },
        expected: { type: 'boolean', value: true, formatted: 'true' },
      },
      {
        value: '00',
        encoding: { f: { encoding: { type: 'boolean' } } },
        expected: { type: 'boolean', value: false, formatted: 'false' },
      },
    ] as Array<{
      value: string;
      encoding: NftParseInfo['fields'];
      expected: Record<string, unknown>;
    }>;

    for (const testCase of cases) {
      const result = parseNftCommitment(
        { commitment: testCase.value },
        { bytecode: '006b00cf6b', types: { '': { name: 'Kitchen Sink', fields: ['f'] } }, fields: testCase.encoding }
      );
      expect(result.success).toBe(true);
      if (!result.success) continue;
      expect(result.fields[0]?.parsedValue).toMatchObject(testCase.expected);
    }
  });

  it('decodes locktime as block height or timestamp', () => {
    const blockResult = parseNftCommitment(
      { commitment: '01' },
      {
        bytecode: '006b00cf6b',
        types: { '': { name: 'T', fields: ['f'] } },
        fields: { f: { encoding: { type: 'locktime' } } },
      }
    );
    expect(blockResult.success).toBe(true);
    if (blockResult.success) {
      expect(blockResult.fields[0]?.parsedValue).toMatchObject({
        type: 'locktime',
        formatted: 'Block 1',
        blockHeight: 1,
      });
    }

    const timeResult = parseNftCommitment(
      { commitment: '00ca9a3b' },
      {
        bytecode: '006b00cf6b',
        types: { '': { name: 'T', fields: ['f'] } },
        fields: { f: { encoding: { type: 'locktime' } } },
      }
    );
    expect(timeResult.success).toBe(true);
    if (timeResult.success) {
      expect(timeResult.fields[0]?.parsedValue).toMatchObject({
        type: 'locktime',
        formatted: '2001-09-09T01:46:40.000Z',
        timestamp: 1_000_000_000,
      });
    }
  });

  it('decodes padded (non-minimal) VM numbers for number fields', () => {
    const result = parseNftCommitment(
      { commitment: '0100' },
      {
        bytecode: '006b00cf6b',
        types: { '': { name: 'T', fields: ['f'] } },
        fields: { f: { encoding: { type: 'number' } } },
      }
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.fields[0]?.parsedValue).toMatchObject({
        type: 'number',
        value: 1n,
        formatted: '1',
      });
    }
  });

  it('rejects non-boolean values for boolean fields', () => {
    const result = parseNftCommitment(
      { commitment: '02' },
      {
        bytecode: '006b00cf6b',
        types: { '': { name: 'T', fields: ['f'] } },
        fields: { f: { encoding: { type: 'boolean' } } },
      }
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('boolean');
  });

  it('renders plain hex for fields without a definition', () => {
    const result = parseNftCommitment(
      { commitment: '00e1f505' },
      { bytecode: '006b00cf6b', types: { '': { name: 'Pledge Receipt' } } }
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]?.value).toBe('00e1f505');
    expect(result.fields[0]?.parsedValue).toBeUndefined();
  });
});

describe('lookupSequentialNftType', () => {
  it('maps commitment hex directly to a type', () => {
    const result = lookupSequentialNftType('8000', {
      types: { '8000': { name: 'Example #128' } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.nftTypeKey).toBe('8000');
    expect(result.nftTypeName).toBe('Example #128');
  });

  it('fails for unknown sequential commitments', () => {
    const result = lookupSequentialNftType('8000', {
      types: { '7f': { name: 'Example #127' } },
    });
    expect(result.success).toBe(false);
  });
});

describe('nftTickerSymbol', () => {
  it('follows the chip-bcmr test vector table', () => {
    const cases: Array<[string, string]> = [
      ['', 'XAMPL-0'],
      ['01', 'XAMPL-1'],
      ['64', 'XAMPL-100'],
      ['7f', 'XAMPL-127'],
      ['80', 'XAMPL-X80'],
      ['81', 'XAMPL-X81'],
      ['ff', 'XAMPL-XFF'],
      ['8000', 'XAMPL-128'],
      ['ff00', 'XAMPL-255'],
      ['ff7f', 'XAMPL-32767'],
      ['8080', 'XAMPL-X8080'],
      ['ff80', 'XAMPL-XFF80'],
      ['ffff', 'XAMPL-XFFFF'],
    ];
    for (const [key, expected] of cases) {
      expect(nftTickerSymbol('XAMPL', key)).toBe(expected);
    }
  });
});

describe('VM number helpers', () => {
  it('reports minimality and encodes minimally', () => {
    expect(isMinimalVmNumberEncoding('')).toBe(true);
    expect(isMinimalVmNumberEncoding('01')).toBe(true);
    expect(isMinimalVmNumberEncoding('0100')).toBe(false);
    expect(isMinimalVmNumberEncoding('8000')).toBe(true);
    expect(isMinimalVmNumberEncoding('ff00')).toBe(true);
    expect(minimallyEncodeVmNumber(0n)).toBe('');
    expect(minimallyEncodeVmNumber(128n)).toBe('8000');
    expect(minimallyEncodeVmNumber(255n)).toBe('ff00');
    expect(minimallyEncodeVmNumber(256n)).toBe('0001');
    expect(minimallyEncodeVmNumber(300n)).toBe('2c01');
  });
});
