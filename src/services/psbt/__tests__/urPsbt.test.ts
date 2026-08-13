import { describe, expect, it } from 'vitest';
import {
  UrPsbtScanner,
  encodePsbtToSingleUr,
  encodePsbtToUrFrames,
} from '../urPsbt';
import { encodeUnsignedPsbt } from '../psbtBch';

const PUBKEY = Uint8Array.from([0x02, ...new Array(32).fill(0x11)]);
const P2PKH = Uint8Array.from([
  0x76, 0xa9, 0x14, ...new Array(20).fill(0x22), 0x88, 0xac,
]);

const psbt = () =>
  encodeUnsignedPsbt(
    [
      {
        txid: 'a'.repeat(64),
        vout: 0,
        satoshis: 50_000n,
        lockingBytecode: P2PKH,
        publicKey: PUBKEY,
        masterFingerprint: Uint8Array.from([1, 2, 3, 4]),
        derivationPath: [0x8000002c, 0x80000091, 0x80000000, 0, 0],
      },
    ],
    [{ lockingBytecode: P2PKH, satoshis: 45_000n }]
  );

describe('UR crypto-psbt transport', () => {
  it('emits ur:crypto-psbt frames', () => {
    const frames = encodePsbtToUrFrames(psbt());
    expect(frames.next().toLowerCase()).toMatch(/^ur:crypto-psbt\//);
    expect(frames.count).toBeGreaterThan(0);
  });

  it('round-trips a PSBT through animated frames', () => {
    const original = psbt();
    const frames = encodePsbtToUrFrames(original, 60);
    const scanner = new UrPsbtScanner();

    let result = scanner.receive(frames.next());
    // Fountain frames repeat; bound the loop so a decoding bug fails the test
    // instead of hanging it.
    for (let i = 0; i < 200 && !result.complete; i += 1) {
      result = scanner.receive(frames.next());
    }

    expect(result.complete).toBe(true);
    expect(result.psbt).not.toBeNull();
    expect([...(result.psbt as Uint8Array)]).toEqual([...original]);
  });

  it('round-trips a single-frame UR', () => {
    const original = psbt();
    const scanner = new UrPsbtScanner();
    const result = scanner.receive(encodePsbtToSingleUr(original));
    expect(result.complete).toBe(true);
    expect([...(result.psbt as Uint8Array)]).toEqual([...original]);
  });

  it('ignores non-UR codes instead of poisoning the scan', () => {
    // A camera sees whatever is in frame. Treating a stray QR as a corrupt
    // fragment would force the user to restart a scan that was going fine.
    const scanner = new UrPsbtScanner();
    expect(scanner.receive('https://example.com').complete).toBe(false);
    expect(scanner.receive('bitcoincash:qsomeaddress').complete).toBe(false);
  });

  it('refuses to encode an empty PSBT', () => {
    expect(() => encodePsbtToUrFrames(new Uint8Array(0))).toThrow();
  });

  it('reset() abandons a partial scan', () => {
    const frames = encodePsbtToUrFrames(psbt(), 60);
    const scanner = new UrPsbtScanner();
    scanner.receive(frames.next());
    scanner.reset();
    expect(scanner.receive('not-a-ur').progress).toBe(0);
  });
});
