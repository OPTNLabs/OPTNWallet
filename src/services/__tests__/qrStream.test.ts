import { describe, expect, it, vi } from 'vitest';
import {
  QrStreamDecoder,
  QrStreamEncoder,
  decodeFrame,
  encodeFrame,
  qrPayloadToBytes,
} from '../qrStream';

function bytes(length: number): Uint8Array {
  return Uint8Array.from(
    { length },
    (_, index) => (index * 37 + (index >> 8) * 11) & 0xff
  );
}

describe('qrStream', () => {
  it('uses secure randomness when no session ID is provided', () => {
    const getRandomValues = vi
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation((array) => {
        (array as Uint16Array)[0] = 0xbeef;
        return array;
      });

    try {
      expect(new QrStreamEncoder(bytes(1)).sessionId).toBe(0xbeef);
      expect(getRandomValues).toHaveBeenCalledOnce();
    } finally {
      getRandomValues.mockRestore();
    }
  });

  it('round-trips arbitrary payloads through a dropped and reordered stream', () => {
    const source = bytes(8_000);
    const encoder = new QrStreamEncoder(source, 180, 4242);
    const decoder = new QrStreamDecoder();
    const frames = Array.from({ length: 220 }, (_, sequence) =>
      encoder.frame(sequence)
    );

    const order = frames.filter((_, index) => index % 7 !== 0).reverse();
    let recovered: Uint8Array | null = null;
    for (const frame of order) {
      recovered = decoder.addFrameBytes(encodeFrame(frame)) ?? recovered;
      if (recovered) break;
    }

    expect(recovered).toEqual(source);
    expect(decoder.progress?.complete).toBe(true);
  });

  it('accepts QR payload strings and ignores malformed data', () => {
    const source = bytes(1_100);
    const encoder = new QrStreamEncoder(source, 200, 12);
    const decoder = new QrStreamDecoder();
    expect(decoder.addQrPayload('not-a-stream')).toBeNull();

    let recovered: Uint8Array | null = null;
    for (let sequence = 0; sequence < 120 && !recovered; sequence += 1) {
      recovered = decoder.addQrPayload(encoder.qrPayload(sequence));
    }
    expect(recovered).toEqual(source);
    expect(qrPayloadToBytes(encoder.qrPayload(0))).not.toBeNull();
  });

  it('resets when a new stream identity appears', () => {
    const first = new QrStreamEncoder(bytes(300), 100, 1);
    const second = new QrStreamEncoder(
      bytes(300).map((value) => value ^ 0xff),
      100,
      2
    );
    const decoder = new QrStreamDecoder();
    decoder.addFrameBytes(encodeFrame(first.frame(0)));
    decoder.addFrameBytes(encodeFrame(second.frame(0)));
    expect(decoder.progress?.sessionId).toBe(2);
    expect(decoder.progress?.framesReceived).toBe(1);
  });

  it('rejects tampered or structurally invalid frames', () => {
    const encoder = new QrStreamEncoder(bytes(100), 100, 7);
    const encoded = encodeFrame(encoder.frame(0));
    encoded[0] ^= 0xff;
    expect(decodeFrame(encoded)).toBeNull();
  });
});
