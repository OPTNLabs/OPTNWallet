// UR (crypto-psbt) transport — the animated-QR channel to an air-gapped signer.
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
 * Small enough that each frame stays readable by a phone-grade camera at the
 * size a desktop window can show, which matters more than frame count: a dense
 * QR that will not scan makes the whole flow fail, while a few extra frames
 * only cost seconds.
 */
export const DEFAULT_UR_FRAGMENT_LENGTH = 200;

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
