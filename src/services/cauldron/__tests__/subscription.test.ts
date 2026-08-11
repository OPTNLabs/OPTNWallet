import { describe, expect, it } from 'vitest';
import { parseCauldronServerEntry } from '../subscription';

describe('parseCauldronServerEntry', () => {
  it('defaults bare hosts to encrypted Rostrum WebSockets', () => {
    expect(parseCauldronServerEntry('rostrum.example')).toEqual({
      host: 'rostrum.example',
      port: 50004,
      encrypted: true,
    });
  });

  it('allows unencrypted WebSockets only on loopback hosts', () => {
    expect(parseCauldronServerEntry('ws://localhost:50003')).toEqual({
      host: 'localhost',
      port: 50003,
      encrypted: false,
    });
    expect(() =>
      parseCauldronServerEntry('ws://rostrum.example:50003')
    ).toThrow('loopback host');
  });

  it('rejects non-WebSocket URL schemes', () => {
    expect(() => parseCauldronServerEntry('http://rostrum.example')).toThrow(
      'WebSocket URL'
    );
  });
});
