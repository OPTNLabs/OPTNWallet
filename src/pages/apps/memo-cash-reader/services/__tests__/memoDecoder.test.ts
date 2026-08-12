import { describe, expect, it } from 'vitest';
import { decodeMemoActionFromLockingBytecode } from '../memoDecoder';

describe('decodeMemoActionFromLockingBytecode', () => {
  it('decodes memo post action', () => {
    const out = decodeMemoActionFromLockingBytecode('6a026d020568656c6c6f');
    expect(out).toEqual({ type: 'post', message: 'hello' });
  });

  it('decodes set_name action', () => {
    const out = decodeMemoActionFromLockingBytecode('6a026d01044a6f686e');
    expect(out).toEqual({ type: 'set_name', name: 'John' });
  });

  it('decodes reply action with txid + message', () => {
    const txid = '11'.repeat(32);
    const msg = '6869'; // "hi"
    const script = `6a026d0320${txid}02${msg}`;
    const out = decodeMemoActionFromLockingBytecode(script);
    expect(out && out.type).toBe('reply');
    if (!out || out.type !== 'reply') return;
    expect(out.txid).toBe(txid);
    expect(out.message).toBe('hi');
  });
});
