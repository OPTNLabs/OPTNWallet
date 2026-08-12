import { describe, expect, it } from 'vitest';
import { parseOpReturnPushes, bytesToHex } from '../opReturn';

describe('parseOpReturnPushes', () => {
  it('parses direct push opcodes (0x01..0x4b)', () => {
    // OP_RETURN | PUSH(2) 6d02 | PUSH(5) "hello"
    const pushes = parseOpReturnPushes('6a026d020568656c6c6f');
    expect(pushes).toHaveLength(2);
    expect(bytesToHex(pushes[0])).toBe('6d02');
    expect(bytesToHex(pushes[1])).toBe('68656c6c6f');
  });

  it('parses OP_PUSHDATA1 payloads', () => {
    const msg = '61'.repeat(80);
    const script = `6a026d024c50${msg}`;
    const pushes = parseOpReturnPushes(script);
    expect(pushes).toHaveLength(2);
    expect(bytesToHex(pushes[0])).toBe('6d02');
    expect(pushes[1]).toHaveLength(80);
  });

  it('parses OP_PUSHDATA2 payloads', () => {
    const msg = '62'.repeat(260);
    // 260 -> 0x0104 little-endian => 0401
    const script = `6a026d024d0401${msg}`;
    const pushes = parseOpReturnPushes(script);
    expect(pushes).toHaveLength(2);
    expect(bytesToHex(pushes[0])).toBe('6d02');
    expect(pushes[1]).toHaveLength(260);
  });
});
