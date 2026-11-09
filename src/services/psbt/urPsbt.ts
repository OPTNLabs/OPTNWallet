// UR (crypto-psbt) transport: the animated QR an air-gapped signer scans, and
// the scanner for the signed return.
//
// The frames come from Rust (crates/optn-core/src/ur.rs) on every surface.
// Phones used to get one static QR of up to 2,400 characters here while
// desktop got 50-byte frames, and SeedCash's camera cannot read the static
// one. The core now refuses any frame denser than the density control's top.
//
// The UR message is the PSBT in one CBOR byte string (BCR-2020-006), which is
// what Keystone writes and what SeedCash now requires:
//
//   SeedCash 30c5ba6  ur_decoder.py  decode_cbor_by_type: one byte string or
//                                    nothing, so a raw PSBT never completes
//                     encode_qr.py   UrPsbtQrEncoder wraps its signed return
//   Keystone          CryptoPSBT     the same wrap
//
// SeedCash before that read the message as the raw PSBT. Signed returns of
// either shape are accepted on the way back.

import { CryptoPSBT } from '@keystonehq/bc-ur-registry-btc';
import { URRegistryDecoder } from '@keystonehq/bc-ur-registry';

import {
  ensureOptnCore,
  psbtUrFrame,
  psbtUrFrameCount,
} from '../../wasm/optn-core';

/**
 * Fragment size, in bytes of the UR payload.
 *
 * Paytaca PstQrDialog e66cafa9d-era used chunkSize=50 (padding=8). SeedCash
 * cameras could read that density. OPTN keeps 50 as the safe default and
 * exposes 100/200/400 as explicit user-selected densities. Extra frames only
 * cost seconds; a dense QR that will not scan fails the whole air-gap.
 */
export const PSBT_UR_FRAGMENT_LENGTHS = [50, 100, 200, 400] as const;

export type PsbtUrFragmentLength = (typeof PSBT_UR_FRAGMENT_LENGTHS)[number];

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

const PSBT_MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff);

export function startsWithPsbtMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PSBT_MAGIC.length) return false;
  return PSBT_MAGIC.every((value, index) => bytes[index] === value);
}

/**
 * Recover PSBT bytes from a decoded `crypto-psbt` UR CBOR field.
 *
 * BCR-2020-006, Keystone and current SeedCash wrap it in a CBOR byte string;
 * SeedCash before 30c5ba6 put the raw PSBT there. Accept both so a signed
 * return from any of them works.
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

/**
 * Split a PSBT into UR frames for display as an animated QR.
 *
 * Rust refuses anything that is not a PSBT and any fragment length above the
 * density control's top, so no caller can draw a QR the signer cannot read.
 */
export function encodePsbtToUrFrames(
  psbt: Uint8Array,
  fragmentLength: number = DEFAULT_UR_FRAGMENT_LENGTH
): UrFrames {
  ensureOptnCore();
  const bytes = Uint8Array.from(psbt);
  const count = rustCall(() => psbtUrFrameCount(bytes, fragmentLength));
  let seqNum = 0;
  return {
    next: () => {
      seqNum += 1;
      return rustCall(() => psbtUrFrame(bytes, fragmentLength, seqNum));
    },
    count,
  };
}

function rustCall<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    // wasm-bindgen throws the Rust error as a bare string.
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The QR to show for a PSBT, the same on a phone as on desktop. It is static
 * only when the whole PSBT fits in one frame; anything larger animates.
 */
export function encodePsbtToQrDisplay(
  psbt: Uint8Array,
  fragmentLength: number = DEFAULT_UR_FRAGMENT_LENGTH
): PsbtQrDisplay {
  const frames = encodePsbtToUrFrames(psbt, fragmentLength);
  if (frames.count === 1) {
    return { mode: 'static', uri: frames.next(), frames: null, count: 1 };
  }
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

  /** Frames the camera handed us that were not readable. Diagnostic only. */
  private damaged = 0;

  /** How many frames were unreadable so far. Zero on a clean scan. */
  get damagedFrames(): number {
    return this.damaged;
  }

  /** Feed one scanned frame. Returns the progress after it. */
  receive(frame: string): UrScanProgress {
    const text = frame.trim();
    // A camera will happily hand us any QR in view; anything that is not a UR
    // is ignored rather than treated as a corrupt frame, which would otherwise
    // poison the decoder and force the user to start over.
    if (!/^ur:/i.test(text)) return this.progress();

    try {
      this.decoder.receivePart(text.toLowerCase());
    } catch {
      // A half-caught frame throws out of the bytewords decoder -- "Invalid
      // Bytewords: value not in lookup table" is the usual one. This is
      // **normal** while a camera reads an animated QR: the shutter catches a
      // frame mid-repaint and gets something that still scans as a QR but is
      // not a whole UR part.
      //
      // It is not fatal, and the decoder is not poisoned by it: the fountain
      // decoder keeps every part it has already accepted, so dropping this one
      // and carrying on still recovers the payload from later frames. That is
      // asserted against frames SeedCash's own encoder produced.
      //
      // This matters most on exactly the transfer that was reported failing.
      // A *signed* PSBT is larger than the unsigned one, so it needs more
      // frames, so the chance of at least one bad read approaches certainty --
      // which made the longest transfers the least likely to ever finish.
      this.damaged += 1;
    }
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
    this.damaged = 0;
  }
}
