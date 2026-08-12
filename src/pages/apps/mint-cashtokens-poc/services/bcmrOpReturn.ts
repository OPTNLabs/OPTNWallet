import { sha256 } from '../../../../utils/hash';
import { binToHex } from '../../../../utils/hex';

export type BcmrPublicationInput = {
  registryJson: string;
  uris?: string[];
};

export type BcmrPublicationOutput = {
  opReturn: string[];
  hashHex: string;
  scriptHex: string;
};

function ensureNonEmpty(value: string, field: string): string {
  if (!value.trim()) {
    throw new Error(`${field} is required for BCMR publication.`);
  }
  return value;
}

function requireUriList(uris: string[]): string[] {
  if (uris.length === 0) {
    throw new Error('At least one BCMR registry URI is required.');
  }
  for (const uri of uris) {
    if (!/^(ipfs|https?):\/\//i.test(uri)) {
      throw new Error(`Invalid BCMR URI: ${uri}`);
    }
  }
  return uris;
}

function pushDataHex(dataHex: string): string {
  const byteLength = dataHex.length / 2;
  if (!Number.isInteger(byteLength)) {
    throw new Error('Invalid pushdata hex length.');
  }
  if (byteLength <= 75) {
    return byteLength.toString(16).padStart(2, '0') + dataHex;
  }
  if (byteLength <= 255) {
    return `4c${byteLength.toString(16).padStart(2, '0')}${dataHex}`;
  }
  if (byteLength <= 65535) {
    const lo = (byteLength & 0xff).toString(16).padStart(2, '0');
    const hi = ((byteLength >> 8) & 0xff).toString(16).padStart(2, '0');
    return `4d${lo}${hi}${dataHex}`;
  }
  throw new Error('Pushdata too large for BCMR publication output.');
}

export function buildBcmrPublicationOpReturn(
  input: BcmrPublicationInput
): BcmrPublicationOutput {
  const registryJson = ensureNonEmpty(input.registryJson, 'Registry JSON');
  const uris = requireUriList(
    (input.uris ?? []).map((uri) => uri.trim()).filter(Boolean)
  );

  const registryBytes = new TextEncoder().encode(registryJson);
  const hashBytes = sha256.hash(registryBytes);
  const hashHex = binToHex(hashBytes);

  const opReturn = ['BCMR', `0x${hashHex}`, ...uris];

  // Raw script layout: OP_RETURN + push("BCMR") + push(32-byte hash) + push(uri...)
  let scriptHex = '6a0442434d5220' + hashHex;
  for (const uri of uris) {
    const uriHex = binToHex(new TextEncoder().encode(uri));
    scriptHex += pushDataHex(uriHex);
  }

  return {
    opReturn,
    hashHex,
    scriptHex,
  };
}

export function parseUrisInput(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
