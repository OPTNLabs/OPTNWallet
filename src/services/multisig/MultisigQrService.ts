import { binToHex, decodeHdPublicKey } from '@bitauth/libauth';
import { CryptoHDKey, URRegistryDecoder } from '@keystonehq/bc-ur-registry';
import { CryptoKeypath, PathComponent } from '@keystonehq/bc-ur-registry';
import { normalizeBchAccountPath } from '../HdWalletService';

export type DecodedMultisigXpub = {
  xpub: string;
  masterFingerprintHex?: string;
  accountPath?: string;
};

export type MultisigCosignerQrPayload = {
  xpub: string;
  masterFingerprintHex: string;
  accountPath: string;
};

/** Encode one complete cosigner record as a standard crypto-hdkey UR. */
export function encodeMultisigCosignerUr(
  payload: MultisigCosignerQrPayload,
  fragmentLength = 1000
): string[] {
  const accountPath = normalizeBchAccountPath(payload.accountPath);
  if (!/^[0-9a-fA-F]{8}$/.test(payload.masterFingerprintHex)) {
    throw new Error(
      'A cosigner QR requires an 8-character master fingerprint.'
    );
  }
  const decoded = decodeHdPublicKey(payload.xpub.trim());
  if (typeof decoded === 'string') {
    throw new Error(`The cosigner xpub is invalid: ${decoded}`);
  }
  const pathComponents = accountPath
    .split('/')
    .slice(1)
    .map((component) => {
      const hardened = component.endsWith("'");
      const value = Number(hardened ? component.slice(0, -1) : component);
      return new PathComponent({ index: value, hardened });
    });
  const key = new CryptoHDKey({
    isMaster: false,
    key: Buffer.from(decoded.node.publicKey),
    chainCode: Buffer.from(decoded.node.chainCode),
    origin: new CryptoKeypath(
      pathComponents,
      Buffer.from(payload.masterFingerprintHex, 'hex')
    ),
  });
  const encoder = key.toUREncoder(fragmentLength);
  return Array.from({ length: encoder.fragmentsLength }, () =>
    encoder.nextPart().toLowerCase()
  );
}

/**
 * Extract an account xpub from either a pasted xpub or a single-part
 * `ur:crypto-hdkey` payload. Animated UR callers should feed each frame to
 * `MultisigHdKeyScanner` instead of treating an incomplete frame as a key.
 */
export function decodeMultisigXpubExport(payload: string): DecodedMultisigXpub {
  const text = payload.trim();
  if (!text) throw new Error('The cosigner export was empty.');
  if (!/^ur:/i.test(text)) return { xpub: text };

  const decoder = new URRegistryDecoder();
  decoder.receivePart(text.toLowerCase());
  if (!decoder.isComplete()) {
    throw new Error(
      'The xpub QR export is animated; scan all frames before importing it.'
    );
  }
  if (!decoder.isSuccess()) {
    throw new Error(
      `The xpub QR export could not be decoded: ${decoder.resultError()}`
    );
  }
  const key = decoder.resultRegistryType();
  if (!(key instanceof CryptoHDKey)) {
    throw new Error(
      'Expected a crypto-hdkey QR export containing an HD public key.'
    );
  }
  if (key.isPrivateKey()) {
    throw new Error(
      'Private extended keys are not accepted for multisig setup.'
    );
  }
  const xpub = key.getBip32Key().trim();
  if (!xpub) throw new Error('The QR export did not contain an xpub.');
  const origin = key.getOrigin?.();
  const sourceFingerprint = origin?.getSourceFingerprint?.();
  const path = origin?.getPath?.();
  return {
    xpub,
    masterFingerprintHex:
      sourceFingerprint && sourceFingerprint.length === 4
        ? binToHex(Uint8Array.from(sourceFingerprint))
        : undefined,
    accountPath: path ? `m/${path}` : undefined,
  };
}

export function decodeMultisigXpubPayload(payload: string): string {
  return decodeMultisigXpubExport(payload).xpub;
}

export class MultisigHdKeyScanner {
  private decoder = new URRegistryDecoder();

  receive(frame: string): {
    complete: boolean;
    progress: number;
    xpub: string | null;
    masterFingerprintHex?: string;
    accountPath?: string;
  } {
    const text = frame.trim();
    if (!/^ur:/i.test(text)) {
      return { complete: false, progress: 0, xpub: null };
    }
    this.decoder.receivePart(text.toLowerCase());
    if (!this.decoder.isComplete()) {
      return {
        complete: false,
        progress: this.decoder.estimatedPercentComplete(),
        xpub: null,
      };
    }
    if (!this.decoder.isSuccess()) {
      throw new Error(
        `The xpub QR export could not be decoded: ${this.decoder.resultError()}`
      );
    }
    const key = this.decoder.resultRegistryType();
    if (!(key instanceof CryptoHDKey) || key.isPrivateKey()) {
      throw new Error('The QR export must contain a public HD key.');
    }
    const origin = key.getOrigin?.();
    const sourceFingerprint = origin?.getSourceFingerprint?.();
    const path = origin?.getPath?.();
    return {
      complete: true,
      progress: 1,
      xpub: key.getBip32Key().trim(),
      masterFingerprintHex:
        sourceFingerprint && sourceFingerprint.length === 4
          ? binToHex(Uint8Array.from(sourceFingerprint))
          : undefined,
      accountPath: path ? `m/${path}` : undefined,
    };
  }

  reset(): void {
    this.decoder = new URRegistryDecoder();
  }
}
