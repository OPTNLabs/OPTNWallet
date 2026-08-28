import {
  SIGHASH_ALL_FORKID_ANYONECANPAY,
  decodePsbt,
} from './psbtBch';
import {
  DEFAULT_UR_FRAGMENT_LENGTH,
  encodePsbtToUrFrames,
} from './urPsbt';

/** CLI and GUI share this. File/stdout UR is Chipnet-only. */
export const WATCH_ONLY_UR_NETWORK = 'chipnet' as const;

export type WatchOnlyUrNetwork = typeof WATCH_ONLY_UR_NETWORK;

/**
 * Refuse mainnet. The unsigned PSBT/UR path is Chipnet-only; there is no
 * mainnet send on this encoder.
 */
export function assertChipnetNetwork(
  network: string
): asserts network is WatchOnlyUrNetwork {
  if (network !== WATCH_ONLY_UR_NETWORK) {
    throw new Error(
      `watch-only UR is Chipnet-only (got "${network}"). Mainnet is not allowed.`
    );
  }
}

/**
 * SeedCash falls back to 0x41 when PSBT_IN_SIGHASH_TYPE is missing.
 * Every input must carry 0xc1 (ALL|FORKID|ANYONECANPAY).
 */
export function assertWatchOnlySighash(psbt: Uint8Array): void {
  const parsed = decodePsbt(psbt);
  if (parsed.inputs.length === 0) {
    throw new Error('PSBT has no inputs.');
  }
  parsed.inputs.forEach((input, index) => {
    if (input.requestedSighashType === null) {
      throw new Error(
        `PSBT input ${index} omits PSBT_IN_SIGHASH_TYPE; 0xc1 is required.`
      );
    }
    if (input.requestedSighashType !== SIGHASH_ALL_FORKID_ANYONECANPAY) {
      const hex = `0x${input.requestedSighashType.toString(16)}`;
      throw new Error(
        `PSBT input ${index} has PSBT_IN_SIGHASH_TYPE ${hex}, not 0xc1.`
      );
    }
  });
}

/** Hex, base64, or raw PSBT bytes. Never treats the payload as a key. */
export function parsePsbtBytes(raw: Uint8Array | string): Uint8Array {
  if (typeof raw !== 'string') {
    if (raw.length >= 5 && raw[0] === 0x70 && raw[1] === 0x73) {
      return Uint8Array.from(raw);
    }
    const asText = Buffer.from(raw).toString('utf8').trim();
    if (/^[0-9a-fA-F]+$/.test(asText) && asText.length % 2 === 0) {
      return Uint8Array.from(Buffer.from(asText, 'hex'));
    }
    const fromB64 = Buffer.from(asText, 'base64');
    if (fromB64.length >= 5 && fromB64[0] === 0x70 && fromB64[1] === 0x73) {
      return Uint8Array.from(fromB64);
    }
    return Uint8Array.from(raw);
  }
  const text = raw.trim();
  if (text.length === 0) throw new Error('Empty PSBT.');
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) {
    return Uint8Array.from(Buffer.from(text, 'hex'));
  }
  const fromB64 = Buffer.from(text, 'base64');
  if (fromB64.length >= 5 && fromB64[0] === 0x70) {
    return Uint8Array.from(fromB64);
  }
  throw new Error('PSBT must be binary, hex, or base64.');
}

/**
 * Same encoder as the watch-only GUI: fragment length 50.
 * Padding 8 is a QR display constant (PSBT_UR_QR_MARGIN_MODULES), not a UR
 * byte. CLI emits UR strings for stdout/files; GUI applies the quiet zone.
 */
export function encodeWatchOnlyUrFrames(psbt: Uint8Array): string[] {
  assertWatchOnlySighash(psbt);
  const ur = encodePsbtToUrFrames(psbt, DEFAULT_UR_FRAGMENT_LENGTH);
  const frames: string[] = [];
  for (let i = 0; i < ur.count; i += 1) {
    frames.push(ur.next());
  }
  return frames;
}
