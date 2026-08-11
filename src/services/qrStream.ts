/**
 * One-way animated QR transport.
 *
 * The fountain-code portions are adapted from the MIT-licensed
 * decimen-optical-transfer project:
 * https://github.com/bashalarmistalt/decimen-optical-transfer
 *
 * This module deliberately does not know about wallets, transactions, or
 * cameras. A QR renderer displays `frameToQrPayload(frame)` and a camera
 * adapter passes decoded strings to `QrStreamDecoder.addQrPayload()`.
 */

export const QR_STREAM_VERSION = 1;
export const QR_STREAM_HEADER_LENGTH = 20;
// jsQR is more reliable on mobile with smaller QR versions than the desktop
// demo's larger frames. Callers can raise this for a controlled environment.
export const QR_STREAM_DEFAULT_BLOCK_LENGTH = 360;
export const QR_STREAM_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

const MAGIC_0 = 0xd1;
const MAGIC_1 = 0x0c;
const LN2 = 0.6931471805599453;
const SOLITON_C = 0.1;
const SOLITON_DELTA = 0.5;

export type QrStreamFrameHeader = {
  sessionId: number;
  sequence: number;
  blockCount: number;
  blockLength: number;
  totalLength: number;
  payloadHash: number;
};

export type QrStreamFrame = {
  header: QrStreamFrameHeader;
  block: Uint8Array;
};

export type QrStreamProgress = {
  sessionId: number;
  framesReceived: number;
  duplicateFrames: number;
  blocksSolved: number;
  blockCount: number;
  complete: boolean;
};

function assertIntegerInRange(
  value: number,
  min: number,
  max: number,
  name: string
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} is outside the supported range`);
  }
}

function secureRandomSessionId(): number {
  const random = new Uint16Array(1);
  globalThis.crypto.getRandomValues(random);
  return random[0]!;
}

/** Deterministic natural log used by the reference wire format. */
function deterministicLog(value: number): number {
  let exponent = 0;
  let mantissa = value;
  while (mantissa >= 1.5) {
    mantissa /= 2;
    exponent += 1;
  }
  while (mantissa < 0.75) {
    mantissa *= 2;
    exponent -= 1;
  }
  const z = (mantissa - 1) / (mantissa + 1);
  const z2 = z * z;
  let term = z;
  let sum = 0;
  for (let n = 1; n <= 21; n += 2) {
    sum += term / n;
    term *= z2;
  }
  return exponent * LN2 + 2 * sum;
}

function solitonCdf(blockCount: number): Float64Array<ArrayBufferLike> {
  const cdf = new Float64Array(blockCount);
  if (blockCount === 1) {
    cdf[0] = 1;
    return cdf;
  }

  const radius = Math.max(
    1,
    SOLITON_C *
      deterministicLog(blockCount / SOLITON_DELTA) *
      Math.sqrt(blockCount)
  );
  const spike = Math.min(blockCount, Math.ceil(blockCount / radius));
  let total = 0;

  for (let degree = 1; degree <= blockCount; degree += 1) {
    const rho = degree === 1 ? 1 / blockCount : 1 / (degree * (degree - 1));
    let tau = 0;
    if (degree < spike) tau = radius / (degree * blockCount);
    else if (degree === spike) {
      tau =
        (radius * Math.max(0, deterministicLog(radius / SOLITON_DELTA))) /
        blockCount;
    }
    total += rho + tau;
    cdf[degree - 1] = total;
  }

  for (let index = 0; index < blockCount; index += 1) cdf[index] /= total;
  cdf[blockCount - 1] = 1;
  return cdf;
}

function splitmix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let value = state ^ (state >>> 16);
    value = Math.imul(value, 0x21f0aaad);
    value ^= value >>> 15;
    value = Math.imul(value, 0x735a2d97);
    value ^= value >>> 15;
    return value >>> 0;
  };
}

function frameIndices(
  blockCount: number,
  cdf: Float64Array<ArrayBufferLike>,
  sessionId: number,
  sequence: number
): number[] {
  let seed =
    (Math.imul(sessionId + 1, 0x9e3779b1) ^ (sequence + 0x85ebca6b)) | 0;
  seed = Math.imul(seed ^ (seed >>> 13), 0xc2b2ae35);
  const random = splitmix32(seed ^ (seed >>> 16));
  const unit = random() * 2 ** -32;
  let low = 0;
  let high = blockCount - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cdf[middle]! >= unit) high = middle;
    else low = middle + 1;
  }

  const degree = Math.min(blockCount, low + 1);
  if (degree > blockCount >> 3) {
    const scratch = new Uint32Array(blockCount);
    for (let index = 0; index < blockCount; index += 1) scratch[index] = index;
    const output: number[] = [];
    for (let index = 0; index < degree; index += 1) {
      const swapIndex = index + (random() % (blockCount - index));
      const temporary = scratch[index]!;
      scratch[index] = scratch[swapIndex]!;
      scratch[swapIndex] = temporary;
      output.push(scratch[index]!);
    }
    return output;
  }

  const selected = new Set<number>();
  while (selected.size < degree) selected.add(random() % blockCount);
  return [...selected];
}

export function payloadHash(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
}

export function encodeFrame(frame: QrStreamFrame): Uint8Array {
  const { header, block } = frame;
  assertIntegerInRange(header.sessionId, 0, 0xffff, 'sessionId');
  assertIntegerInRange(header.sequence, 0, 0xffffffff, 'sequence');
  assertIntegerInRange(header.blockCount, 1, 0xffff, 'blockCount');
  assertIntegerInRange(header.blockLength, 1, 0xffff, 'blockLength');
  assertIntegerInRange(header.totalLength, 1, 0xffffffff, 'totalLength');
  if (block.length !== header.blockLength)
    throw new Error('Frame block length does not match its header');

  const bytes = new Uint8Array(QR_STREAM_HEADER_LENGTH + block.length);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MAGIC_0);
  view.setUint8(1, MAGIC_1);
  view.setUint16(2, header.sessionId, true);
  view.setUint32(4, header.sequence, true);
  view.setUint16(8, header.blockCount, true);
  view.setUint16(10, header.blockLength, true);
  view.setUint32(12, header.totalLength, true);
  view.setUint32(16, header.payloadHash, true);
  bytes.set(block, QR_STREAM_HEADER_LENGTH);
  return bytes;
}

export function decodeFrame(bytes: Uint8Array): QrStreamFrame | null {
  if (
    bytes.length <= QR_STREAM_HEADER_LENGTH ||
    bytes[0] !== MAGIC_0 ||
    bytes[1] !== MAGIC_1
  )
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: QrStreamFrameHeader = {
    sessionId: view.getUint16(2, true),
    sequence: view.getUint32(4, true),
    blockCount: view.getUint16(8, true),
    blockLength: view.getUint16(10, true),
    totalLength: view.getUint32(12, true),
    payloadHash: view.getUint32(16, true),
  };
  if (
    header.blockCount === 0 ||
    header.blockLength === 0 ||
    header.totalLength === 0 ||
    header.totalLength > QR_STREAM_MAX_PAYLOAD_BYTES ||
    bytes.length !== QR_STREAM_HEADER_LENGTH + header.blockLength
  )
    return null;
  return { header, block: bytes.slice(QR_STREAM_HEADER_LENGTH) };
}

export function bytesToQrPayload(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize)
    );
  }
  return `qrstream/${QR_STREAM_VERSION}/${btoa(binary)}`;
}

export function qrPayloadToBytes(payload: string): Uint8Array | null {
  const match = /^qrstream\/(\d+)\/([A-Za-z0-9+/=_-]+)$/.exec(payload.trim());
  if (!match || Number(match[1]) !== QR_STREAM_VERSION) return null;
  try {
    const binary = atob(match[2]!.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export class QrStreamEncoder {
  readonly sessionId: number;
  readonly blockCount: number;
  private readonly blocks: Uint32Array;
  private readonly words: number;
  private readonly cdf: Float64Array<ArrayBufferLike>;

  constructor(
    payload: Uint8Array,
    readonly blockLength = QR_STREAM_DEFAULT_BLOCK_LENGTH,
    sessionId = secureRandomSessionId()
  ) {
    if (payload.length === 0)
      throw new Error('QR stream payload cannot be empty');
    if (payload.length > QR_STREAM_MAX_PAYLOAD_BYTES)
      throw new Error('QR stream payload is too large');
    assertIntegerInRange(blockLength, 1, 0xffff, 'blockLength');
    assertIntegerInRange(sessionId, 0, 0xffff, 'sessionId');
    this.sessionId = sessionId;
    this.blockCount = Math.max(1, Math.ceil(payload.length / blockLength));
    if (this.blockCount > 0xffff)
      throw new Error('QR stream has too many source blocks');
    this.words = Math.ceil(blockLength / 4);
    this.blocks = new Uint32Array(this.blockCount * this.words);
    new Uint8Array(this.blocks.buffer).set(payload);
    this.cdf = solitonCdf(this.blockCount);
    this.totalLength = payload.length;
  }

  readonly totalLength: number;

  frame(sequence: number): QrStreamFrame {
    assertIntegerInRange(sequence, 0, 0xffffffff, 'sequence');
    const output = new Uint32Array(this.words);
    for (const blockIndex of frameIndices(
      this.blockCount,
      this.cdf,
      this.sessionId,
      sequence
    )) {
      const offset = blockIndex * this.words;
      for (let word = 0; word < this.words; word += 1)
        output[word] = (output[word]! ^ this.blocks[offset + word]!) >>> 0;
    }
    const block = new Uint8Array(output.buffer, 0, this.blockLength);
    return {
      header: {
        sessionId: this.sessionId,
        sequence,
        blockCount: this.blockCount,
        blockLength: this.blockLength,
        totalLength: this.totalLength,
        payloadHash: payloadHash(
          new Uint8Array(this.blocks.buffer).subarray(0, this.totalLength)
        ),
      },
      block: block.slice(),
    };
  }

  qrPayload(sequence: number): string {
    return bytesToQrPayload(encodeFrame(this.frame(sequence)));
  }
}

type PendingFrame = { indices: Set<number>; words: Uint32Array };

export class QrStreamDecoder {
  private words = 0;
  private cdf: Float64Array<ArrayBufferLike> = new Float64Array();
  private solved: Array<Uint32Array | null> = [];
  private readonly waiting = new Map<number, Set<PendingFrame>>();
  private readonly seen = new Set<number>();
  private sessionIdValue: number | null = null;
  private blockCountValue = 0;
  private blockLengthValue = 0;
  private totalLengthValue = 0;
  private payloadHashValue = 0;
  private framesReceivedValue = 0;
  private duplicateFramesValue = 0;
  private solvedCount = 0;

  get progress(): QrStreamProgress | null {
    if (this.sessionIdValue === null) return null;
    return {
      sessionId: this.sessionIdValue,
      framesReceived: this.framesReceivedValue,
      duplicateFrames: this.duplicateFramesValue,
      blocksSolved: this.solvedCount,
      blockCount: this.blockCountValue,
      complete: this.isComplete,
    };
  }

  get isComplete(): boolean {
    return (
      this.sessionIdValue !== null && this.solvedCount === this.blockCountValue
    );
  }

  addQrPayload(payload: string): Uint8Array | null {
    const bytes = qrPayloadToBytes(payload);
    return bytes ? this.addFrameBytes(bytes) : null;
  }

  addFrameBytes(bytes: Uint8Array): Uint8Array | null {
    const frame = decodeFrame(bytes);
    if (!frame) return null;
    const { header, block } = frame;

    if (
      header.blockCount > 0xffff ||
      header.blockCount * header.blockLength > QR_STREAM_MAX_PAYLOAD_BYTES ||
      header.totalLength > QR_STREAM_MAX_PAYLOAD_BYTES
    )
      return null;

    const identity = `${header.sessionId}:${header.blockCount}:${header.blockLength}:${header.totalLength}:${header.payloadHash}`;
    const currentIdentity =
      this.sessionIdValue === null
        ? null
        : `${this.sessionIdValue}:${this.blockCountValue}:${this.blockLengthValue}:${this.totalLengthValue}:${this.payloadHashValue}`;
    if (currentIdentity !== identity) this.reset(header);

    if (this.seen.has(header.sequence)) {
      this.duplicateFramesValue += 1;
      return null;
    }
    this.seen.add(header.sequence);
    this.framesReceivedValue += 1;
    if (this.isComplete) return this.assemble();

    const indices = new Set(
      frameIndices(
        this.blockCountValue,
        this.cdf,
        header.sessionId,
        header.sequence
      )
    );
    const words = new Uint32Array(this.words);
    new Uint8Array(words.buffer).set(block);
    for (const index of [...indices]) {
      const solved = this.solved[index];
      if (solved) {
        for (let word = 0; word < words.length; word += 1)
          words[word] = (words[word]! ^ solved[word]!) >>> 0;
        indices.delete(index);
      }
    }
    if (indices.size === 1) this.resolve(indices.values().next().value!, words);
    else if (indices.size > 1) {
      const pending = { indices, words };
      for (const index of indices) {
        let frames = this.waiting.get(index);
        if (!frames) {
          frames = new Set();
          this.waiting.set(index, frames);
        }
        frames.add(pending);
      }
    }

    return this.isComplete ? this.assemble() : null;
  }

  private reset(header: QrStreamFrameHeader): void {
    this.sessionIdValue = header.sessionId;
    this.blockCountValue = header.blockCount;
    this.blockLengthValue = header.blockLength;
    this.totalLengthValue = header.totalLength;
    this.payloadHashValue = header.payloadHash;
    this.words = Math.ceil(header.blockLength / 4);
    this.cdf = solitonCdf(header.blockCount);
    this.solved = new Array(header.blockCount).fill(null);
    this.waiting.clear();
    this.seen.clear();
    this.framesReceivedValue = 0;
    this.duplicateFramesValue = 0;
    this.solvedCount = 0;
  }

  private resolve(index: number, words: Uint32Array): void {
    const queue: Array<[number, Uint32Array]> = [[index, words]];
    while (queue.length > 0) {
      const [resolvedIndex, resolvedWords] = queue.pop()!;
      if (this.solved[resolvedIndex]) continue;
      this.solved[resolvedIndex] = resolvedWords;
      this.solvedCount += 1;
      const pendingFrames = this.waiting.get(resolvedIndex);
      if (!pendingFrames) continue;
      this.waiting.delete(resolvedIndex);
      for (const pending of pendingFrames) {
        for (let word = 0; word < pending.words.length; word += 1)
          pending.words[word] =
            (pending.words[word]! ^ resolvedWords[word]!) >>> 0;
        pending.indices.delete(resolvedIndex);
        if (pending.indices.size === 1) {
          const remaining = pending.indices.values().next().value!;
          this.waiting.get(remaining)?.delete(pending);
          if (!this.solved[remaining]) queue.push([remaining, pending.words]);
        }
      }
    }
  }

  private assemble(): Uint8Array {
    if (!this.isComplete) throw new Error('QR stream is incomplete');
    const payload = new Uint8Array(this.totalLengthValue);
    for (let index = 0; index < this.blockCountValue; index += 1) {
      const start = index * this.blockLengthValue;
      const length = Math.min(
        this.blockLengthValue,
        this.totalLengthValue - start
      );
      payload.set(new Uint8Array(this.solved[index]!.buffer, 0, length), start);
    }
    if (payloadHash(payload) !== this.payloadHashValue)
      throw new Error('QR stream payload hash mismatch');
    return payload;
  }
}
