// UR (crypto-psbt) transport — the animated-QR channel to an air-gapped signer.
//
// Both devices we target speak the same thing, so one layer serves both:
//   SeedCash  encode_qr.py:280  UR("crypto-psbt", self.psbt) + fountain encoder
//             qr_type.py        PSBT__UR2
//   Keystone  CryptoPSBT from @keystonehq/bc-ur-registry-btc
//
// A PSBT rarely fits one QR frame, so UR splits it into fragments a device
// scans in sequence. Decoding is the mirror: frames arrive out of order and
// possibly repeated (the fountain encoder loops), and the decoder accumulates
// until it has enough.

import { CryptoPSBT } from '@keystonehq/bc-ur-registry-btc';
import { URRegistryDecoder } from '@keystonehq/bc-ur-registry';

/**
 * Fragment size, in characters of the encoded UR.
 *
 * Small enough that each frame stays readable by a phone-grade camera at the
 * size a desktop window can show, which matters more than frame count: a dense
 * QR that will not scan makes the whole flow fail, while a few extra frames
 * only cost seconds.
 */
export const DEFAULT_UR_FRAGMENT_LENGTH = 200;

export interface UrFrames {
  /** Next frame to display; loops forever, so drive it from a timer. */
  next(): string;
  /** Frames in one full pass — for "1 of N" style progress. */
  count: number;
}

/** Split a PSBT into UR frames for display as an animated QR. */
export function encodePsbtToUrFrames(
  psbt: Uint8Array,
  fragmentLength: number = DEFAULT_UR_FRAGMENT_LENGTH
): UrFrames {
  if (psbt.length === 0) throw new Error('Cannot encode an empty PSBT.');
  const encoder = new CryptoPSBT(Buffer.from(psbt)).toUREncoder(fragmentLength);
  return {
    next: () => encoder.nextPart().toUpperCase(),
    count: encoder.fragmentsLength,
  };
}

/** A single-frame UR, for the rare PSBT small enough to need no animation. */
export function encodePsbtToSingleUr(psbt: Uint8Array): string {
  if (psbt.length === 0) throw new Error('Cannot encode an empty PSBT.');
  // Produced through the same encoder with a fragment large enough to hold the
  // whole payload, rather than a separate code path that could drift from the
  // animated one.
  return new CryptoPSBT(Buffer.from(psbt))
    .toUREncoder(Math.max(psbt.length * 3, 1024))
    .nextPart()
    .toUpperCase();
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
      psbt: Uint8Array.from(CryptoPSBT.fromCBOR(result.cbor).getPSBT()),
    };
  }

  /** Start over — e.g. the user aborted, or scanned the wrong device's screen. */
  reset(): void {
    this.decoder = new URRegistryDecoder();
  }
}
