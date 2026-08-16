import { describe, expect, it } from 'vitest';
import {
  clearRoundNullifiers,
  consumeOutputNullifiers,
} from '../fusionCredentialNullifiers';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('active-round output credential nullifiers', () => {
  it('persists consumption across coordinator reconstruction and clears only on retirement', () => {
    const storage = new MemoryStorage();
    const session = 'aa'.repeat(32);
    const serial = 'bb'.repeat(32);
    expect(consumeOutputNullifiers(session, [serial], storage)).toBe(true);
    expect(consumeOutputNullifiers(session, [serial], storage)).toBe(false);
    clearRoundNullifiers(session, storage);
    expect(consumeOutputNullifiers(session, [serial], storage)).toBe(true);
  });

  it('atomically rejects a batch containing duplicate or previously used serials', () => {
    const storage = new MemoryStorage();
    const session = 'cc'.repeat(32);
    const one = '11'.repeat(32);
    const two = '22'.repeat(32);
    expect(consumeOutputNullifiers(session, [one, one], storage)).toBe(false);
    expect(consumeOutputNullifiers(session, [one, two], storage)).toBe(true);
    expect(
      consumeOutputNullifiers(session, ['33'.repeat(32), two], storage)
    ).toBe(false);
    expect(consumeOutputNullifiers(session, ['33'.repeat(32)], storage)).toBe(
      true
    );
  });
});
