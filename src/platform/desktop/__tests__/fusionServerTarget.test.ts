import { describe, expect, it } from 'vitest';

import { parseFusionServerTarget } from '../fusionServerTarget';

describe('server endpoint parsing', () => {
  it('parses CashFusion TLS/plain targets and rejects ambiguous input', () => {
    expect(parseFusionServerTarget('fusion.example:8789')).toEqual({
      host: 'fusion.example',
      port: 8789,
      useSsl: true,
    });
    expect(parseFusionServerTarget('localhost:8788:t')).toEqual({
      host: 'localhost',
      port: 8788,
      useSsl: false,
    });
    expect(() => parseFusionServerTarget('')).toThrow('invalid');
    expect(() => parseFusionServerTarget('host:70000')).toThrow('invalid');
  });
});

describe('fusion server scheme defaults', () => {
  it('uses plain TCP for a local server, because server.py has no TLS', () => {
    // Defaulting loopback to SSL produced "TLS handshake failed: tls handshake
    // eof" against a perfectly healthy local Electron Cash server, which reads
    // as a broken server rather than as us speaking the wrong protocol at it.
    expect(parseFusionServerTarget('127.0.0.1:8787')).toEqual({
      host: '127.0.0.1',
      port: 8787,
      useSsl: false,
    });
    expect(parseFusionServerTarget('localhost:8787').useSsl).toBe(false);
  });

  it('still defaults a remote server to SSL', () => {
    // Sending fusion traffic to the internet in the clear is the worse mistake.
    expect(parseFusionServerTarget('fusion.servo.cash:8789').useSsl).toBe(true);
  });

  it('lets an explicit suffix override both defaults', () => {
    expect(parseFusionServerTarget('127.0.0.1:8787:s').useSsl).toBe(true);
    expect(parseFusionServerTarget('fusion.servo.cash:8789:t').useSsl).toBe(
      false
    );
  });
});
