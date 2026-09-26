import { describe, expect, it } from 'vitest';
import { transactionOutpoints as inspect } from '..';

// Exercise Rust's generated binding, with public unsigned bytes only.
const WIRE_TXID = 'efcdab8967452301'.repeat(4);
const DISPLAY_TXID = '0123456789abcdef'.repeat(4);
const INPUT = `${WIRE_TXID}0403020100ffffffff`;
const OUTPUTS = '01e803000000000000015100000000';
const SINGLE = `0200000001${INPUT}${OUTPUTS}`;

describe('Rust transactionOutpoints binding', () => {
  it('exports the inspector from the generated Rust bundle', () => {
    expect(inspect).toBeTypeOf('function');
  });

  it('returns every input in display order with its exact index', () => {
    const second = `${'ab'.repeat(32)}ffffffff00feffffff`;
    expect(
      JSON.parse(inspect(`0200000002${INPUT}${second}${OUTPUTS}`))
    ).toEqual([
      { txid: DISPLAY_TXID, vout: 0x01020304 },
      { txid: 'ab'.repeat(32), vout: 0xffffffff },
    ]);
    expect(JSON.parse(inspect(SINGLE.toUpperCase()))).toEqual([
      { txid: DISPLAY_TXID, vout: 0x01020304 },
    ]);
  });

  it.each([
    ['invalid hex', 'zz'],
    ['signed hex byte', `+2${SINGLE.slice(2)}`],
    ['non-ASCII hex', `é${SINGLE.slice(2)}`],
    ['odd hex', `${SINGLE}0`],
    ['truncated input', '0200000001ab'],
    ['truncated locktime', SINGLE.slice(0, -2)],
    ['trailing bytes', `${SINGLE}00`],
    ['noncanonical count', `02000000fd0100${INPUT}${OUTPUTS}`],
    ['no inputs', '02000000000000000000'],
  ])('refuses %s without returning an empty input list', (_name, raw) => {
    expect(inspect).toBeTypeOf('function');
    expect(() => inspect(raw)).toThrow();
  });
});
