import { beforeEach, describe, expect, it } from 'vitest';
import { readTransportConfig, writeTransportConfig } from '../transportConfig';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

const full = {
  torEnabled: true,
  torAuto: false,
  torHost: '127.0.0.1',
  torPortManual: 9150,
  fusionServer: 'chipnet.bch.ninja:8789',
  fusionServers: ['chipnet.bch.ninja:8789'],
  nostrRelays: ['wss://relay.damus.io'],
};

const store = () =>
  (globalThis as { localStorage: MemoryStorage }).localStorage;

describe('shared transport config', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  it('returns null before anything is stored, so defaults are not overwritten', () => {
    // The caller already holds redux defaults; inventing them here would let a
    // first run persist this module's idea of the defaults instead.
    expect(readTransportConfig()).toBeNull();
  });

  it('round-trips a full config, so another window sees the same transport', () => {
    writeTransportConfig(full);
    expect(readTransportConfig()).toEqual(full);
  });

  it('rejects an empty relay pool', () => {
    // No relays means P2P fusion can never find a peer, which surfaces as
    // "no peers" rather than as a broken setting.
    writeTransportConfig({ ...full, nostrRelays: [] });
    expect(readTransportConfig()?.nostrRelays).toBeUndefined();
  });

  it('rejects an unusable Tor port rather than routing nowhere', () => {
    writeTransportConfig({ ...full, torPortManual: 0 });
    expect(readTransportConfig()?.torPortManual).toBeUndefined();

    writeTransportConfig({ ...full, torPortManual: 70000 });
    expect(readTransportConfig()?.torPortManual).toBeUndefined();
  });

  it('keeps valid fields when a record is partially written', () => {
    store().setItem(
      'optn-transport-config',
      JSON.stringify({ torEnabled: false, nostrRelays: ['wss://a'] })
    );
    const loaded = readTransportConfig();
    expect(loaded?.torEnabled).toBe(false);
    expect(loaded?.nostrRelays).toEqual(['wss://a']);
    // Absent keys stay absent so the caller keeps its current value.
    expect(loaded?.torHost).toBeUndefined();
  });

  it('ignores a corrupt record rather than throwing', () => {
    store().setItem('optn-transport-config', 'not json');
    expect(readTransportConfig()).toBeNull();
  });

  it('drops a relay list containing non-strings', () => {
    store().setItem(
      'optn-transport-config',
      JSON.stringify({ nostrRelays: ['wss://ok', 42] })
    );
    expect(readTransportConfig()?.nostrRelays).toBeUndefined();
  });
});
