// UR (crypto-psbt) transport — a static QR for small payloads and an
// animated-QR channel for larger payloads.
//
// SeedCash and Keystone both use type `crypto-psbt`, but they do not put the
// same bytes in the UR CBOR field:
//
//   SeedCash  encode_qr.py:280  UR("crypto-psbt", raw_psbt_bytes)
//             decode_qr.py:141  parse_psbt(decoder.result_message().cbor)
//   Keystone  CryptoPSBT        CBOR byte-string wrap (BCR-2020-006)
//
// Stock SeedCash never unwraps that byte string. A spec-wrapped QR therefore
// arrives as `59 01 90 70 73 62 74 ff …` and `parse_psbt` dies with
// "invalid PSBT magic". Issue #8 is the SeedCash air-gap, so we emit the
// device's native payload (raw PSBT as the UR CBOR) and accept both shapes
// on the way back.

import { UR, UREncoder } from '@ngraveio/bc-ur';
import { CryptoPSBT } from '@keystonehq/bc-ur-registry-btc';
import { URRegistryDecoder } from '@keystonehq/bc-ur-registry';

/**
 * Fragment size, in bytes of the UR payload.
 *
 * Paytaca PstQrDialog e66cafa9d-era used chunkSize=50 (padding=8). SeedCash
 * cameras could read that density. OPTN keeps 50 as the safe default and
 * exposes 100/200/400 as explicit user-selected densities. Extra frames only
 * cost seconds; a dense QR that will not scan fails the whole air-gap.
 */
export const PSBT_UR_FRAGMENT_LENGTHS = [50, 100, 200, 400] as const;

export type PsbtUrFragmentLength =
  (typeof PSBT_UR_FRAGMENT_LENGTHS)[number];

/**
 * Conservative default for SeedCash camera compatibility.
 *
 * Users may raise the density when their signer camera can resolve it; keeping
 * 50 as the default preserves the known-good Paytaca-era behavior.
 */
export const DEFAULT_UR_FRAGMENT_LENGTH: PsbtUrFragmentLength = 50;

export function isPsbtUrFragmentLength(
  value: number
): value is PsbtUrFragmentLength {
  return (PSBT_UR_FRAGMENT_LENGTHS as readonly number[]).includes(value);
}

/**
 * User-selectable UR fragment lengths. Lower values make larger, easier-to-scan
 * QR modules and take more animation frames; higher values do the reverse.
 */
export const UR_FRAGMENT_LENGTH_OPTIONS = [50, 100, 200, 400, 450] as const;

/**
 * Quiet-zone modules around the displayed QR (qrcode.react `marginSize`).
 * Paytaca PstQrDialog e66cafa9d-era used padding=8; later densified to 4.
 * More padding, not denser modules: SeedCash cameras need the extra border.
 */
export const PSBT_UR_QR_MARGIN_MODULES = 8;

/**
 * CSS pixel size of the PSBT UR QR. Shared by Android webview and desktop.
 * Pair with `w-full` so the box fills the send card. Do not shrink this to
 * cram more bytes on screen — lower density via fragment length, not pixels.
 */
export const PSBT_UR_QR_DISPLAY_SIZE = 640;

/** Keep L. Q/H add modules and densify the same UR payload. */
export const PSBT_UR_QR_ERROR_LEVEL = 'L' as const;

/**
 * Keep ordinary PSBTs in one QR at the mobile display size. The value is a
 * character limit for the rendered UR, not a PSBT byte limit: UR framing adds
 * its own header and encoding overhead. Larger payloads use fountain frames.
 */
export const DEFAULT_STATIC_UR_MAX_CHARACTERS = 2_400;

const PSBT_MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff);

export function startsWithPsbtMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PSBT_MAGIC.length) return false;
  return PSBT_MAGIC.every((value, index) => bytes[index] === value);
}

/**
 * Recover PSBT bytes from a decoded `crypto-psbt` UR CBOR field.
 *
 * SeedCash puts the raw PSBT there. BCR-2020-006 / Keystone wrap it in a
 * CBOR byte string. Accept both so a signed return from either device works.
 */
export function extractPsbtFromUrCbor(cbor: Uint8Array): Uint8Array {
  if (startsWithPsbtMagic(cbor)) {
    return Uint8Array.from(cbor);
  }
  return Uint8Array.from(CryptoPSBT.fromCBOR(Buffer.from(cbor)).getPSBT());
}

export interface UrFrames {
  /** Next frame to display; loops forever, so drive it from a timer. */
  next(): string;
  /** Frames in one full pass — for "1 of N" style progress. */
  count: number;
}

export type PsbtQrDisplay = {
  mode: 'static' | 'stream';
  uri: string;
  frames: UrFrames | null;
  count: number;
};

function toSeedCashUr(psbt: Uint8Array): UR {
  return new UR(Buffer.from(psbt), 'crypto-psbt');
}

/** Split a PSBT into UR frames for display as an animated QR. */
export function encodePsbtToUrFrames(
  psbt: Uint8Array,
  fragmentLength: number = DEFAULT_UR_FRAGMENT_LENGTH
): UrFrames {
  if (psbt.length === 0) throw new Error('Cannot encode an empty PSBT.');
  const encoder = new UREncoder(toSeedCashUr(psbt), fragmentLength);
  return {
    next: () => encoder.nextPart().toUpperCase(),
    count: encoder.fragmentsLength,
  };
}

/** A single-frame UR, for the rare PSBT small enough to need no animation. */
export function encodePsbtToSingleUr(psbt: Uint8Array): string {
  if (psbt.length === 0) throw new Error('Cannot encode an empty PSBT.');
  return UREncoder.encodeSinglePart(toSeedCashUr(psbt)).toUpperCase();
}

/**
 * Choose the least cumbersome QR transport for a PSBT. Small unsigned and
 * partially signed PSBTs stay as one static QR; only payloads that would make
 * the phone-sized QR unreasonably dense use the animated stream.
 */
export function encodePsbtToQrDisplay(
  psbt: Uint8Array,
  staticMaxCharacters: number = DEFAULT_STATIC_UR_MAX_CHARACTERS
): PsbtQrDisplay {
  let single: string | null = null;
  try {
    const candidate = encodePsbtToSingleUr(psbt);
    if (candidate.length <= staticMaxCharacters) single = candidate;
  } catch {
    // The single-frame encoder has its own maximum capacity. Fall through to
    // the streaming encoder for larger PSBTs.
  }

  if (single !== null) {
    return { mode: 'static', uri: single, frames: null, count: 1 };
  }

  const frames = encodePsbtToUrFrames(psbt);
  return { mode: 'stream', uri: frames.next(), frames, count: frames.count };
}

export interface UrScanProgress {
  complete: boolean;
  /** 0..1, for a progress bar while the user holds the camera steady. */
  progress: number;
  psbt: Uint8Array | null;
}

/**
 * Accumulates scanned UR frames until a PSBT is recovered.
 *
 * Stateful by necessity — frames arrive one at a time from a camera. Feed every
 * decoded QR string in; duplicates and out-of-order frames are expected and
 * handled by the decoder rather than by the caller.
 */
export class UrPsbtScanner {
  private decoder = new URRegistryDecoder();

  /** Feed one scanned frame. Returns the progress after it. */
  receive(frame: string): UrScanProgress {
    const text = frame.trim();
    // A camera will happily hand us any QR in view; anything that is not a UR
    // is ignored rather than treated as a corrupt frame, which would otherwise
    // poison the decoder and force the user to start over.
    if (!/^ur:/i.test(text)) return this.progress();

    this.decoder.receivePart(text.toLowerCase());
    return this.progress();
  }

  private progress(): UrScanProgress {
    if (!this.decoder.isComplete()) {
      return {
        complete: false,
        progress: this.decoder.estimatedPercentComplete(),
        psbt: null,
      };
    }
    if (!this.decoder.isSuccess()) {
      throw new Error(
        `Scanned code could not be decoded: ${this.decoder.resultError()}`
      );
    }
    const result = this.decoder.resultUR();
    if (result.type !== 'crypto-psbt') {
      // A crypto-hdkey (an xpub export) is the other thing these devices show,
      // and it is a plausible mis-scan. Naming what arrived is more useful than
      // "invalid QR".
      throw new Error(
        `Expected a signed transaction (crypto-psbt) but scanned "${result.type}".`
      );
    }
    return {
      complete: true,
      progress: 1,
      psbt: extractPsbtFromUrCbor(Uint8Array.from(result.cbor)),
    };
  }

  /** Start over — e.g. the user aborted, or scanned the wrong device's screen. */
  reset(): void {
    this.decoder = new URRegistryDecoder();
  }
}
