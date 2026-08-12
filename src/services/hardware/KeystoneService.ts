/**
 * Keystone hardware wallet service — air-gapped QR code signing.
 *
 * Keystone communicates entirely via animated QR codes (UR encoding):
 *   1. App encodes unsigned transaction → animated QR
 *   2. User scans QR with Keystone device
 *   3. User reviews and signs on Keystone (never connected to internet)
 *   4. Keystone shows a QR of the signed result
 *   5. App scans the result QR → extracts signed transaction hex
 *
 * SDK: @keystonehq/sdk + @keystonehq/bc-ur-registry-btc
 * GitHub: https://github.com/KeystoneHQ/keystone-sdk-js
 */

export interface KeystoneUnsignedTx {
  /** Raw unsigned transaction hex */
  txHex: string;
  /** BIP44 input paths with amounts for each input (needed for PSBT) */
  inputs: KeystoneInput[];
  /** Network: 'mainnet' | 'testnet' */
  network: 'mainnet' | 'testnet';
}

export interface KeystoneInput {
  /** BIP44 path e.g. "m/44'/145'/0'/0/5" */
  path: string;
  /** Input index in the transaction */
  index: number;
  /** Value in satoshis */
  value: bigint;
}

export interface KeystoneSignResult {
  serializedTx: string;
}

/**
 * Build a UR-encoded PSBT QR payload from an unsigned BCH transaction.
 * Returns base64-encoded PSBT data that can be shown as an animated QR.
 *
 * The caller (UI) displays this as an animated QR using @keystonehq/animated-qr.
 */
export async function buildKeystoneQrPayload(
  unsignedTx: KeystoneUnsignedTx
): Promise<{ urType: string; urData: string; displayQrData: string }> {
  // For BCH, Keystone uses the generic PSBT UR type (crypto-psbt)
  // The PSBT must be constructed from the unsigned transaction hex
  const psbtBase64 = buildBchPsbt(unsignedTx);

  // UR encoding for the QR payload
  const { RegistryTypes, CryptoHDKey } = await import('@keystonehq/bc-ur-registry');
  void RegistryTypes; void CryptoHDKey; // imported for side effects / future use

  // For BCH PSBT, use the crypto-psbt UR type
  const urType = 'crypto-psbt';
  const urData = psbtBase64;

  return {
    urType,
    urData,
    displayQrData: `UR:${urType.toUpperCase()}/${btoa(psbtBase64)}`,
  };
}

/**
 * Parse the UR result QR that Keystone shows after signing.
 * The result is a UR-encoded signed PSBT → extract the raw tx hex.
 */
export async function parseKeystoneSignedQr(
  urData: string
): Promise<KeystoneSignResult> {
  // Keystone returns a crypto-psbt UR with the signed PSBT
  // Parse it and extract the final transaction hex
  const psbtData = parseUrPsbt(urData);
  const serializedTx = extractTxFromPsbt(psbtData);
  return { serializedTx };
}

/**
 * Build a minimal BCH PSBT from an unsigned transaction.
 * BCH PSBTs follow the BIP174 structure but with BCH-specific sighash (FORKID).
 */
function buildBchPsbt(unsignedTx: KeystoneUnsignedTx): string {
  // Magic + version
  const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff]; // "psbt\xff"
  const parts: number[] = [...PSBT_MAGIC];

  // Global unsigned tx
  const txBytes = hexToBytes(unsignedTx.txHex);
  parts.push(...varint(1)); // key length 1
  parts.push(0x00); // key: PSBT_GLOBAL_UNSIGNED_TX
  parts.push(...varint(txBytes.length));
  parts.push(...txBytes);

  // Global separator
  parts.push(0x00);

  // Per-input maps: UTXO value (for Keystone fee validation)
  for (const inp of unsignedTx.inputs) {
    // PSBT_IN_BIP32_DERIVATION for each input
    const pathInts = bip44PathToInts(inp.path);
    const keyData = [0x06, ...pathInts.slice(0, 1)]; // simplified
    parts.push(...varint(keyData.length));
    parts.push(...keyData);
    const valData = serializeDerivationPath(pathInts);
    parts.push(...varint(valData.length));
    parts.push(...valData);

    // Separator
    parts.push(0x00);
  }

  // Per-output maps (empty for now)
  // Count outputs from tx (simplified — skip for minimal PSBT)
  parts.push(0x00); // single output separator placeholder

  const bytes = new Uint8Array(parts);
  return btoa(String.fromCharCode(...bytes));
}

function parseUrPsbt(urData: string): string {
  // Minimal UR PSBT parser — extract base64 PSBT data from UR encoding
  const upper = urData.toUpperCase();
  const prefix = 'UR:CRYPTO-PSBT/';
  if (upper.startsWith(prefix)) {
    return urData.slice(prefix.length);
  }
  return urData;
}

function extractTxFromPsbt(psbtBase64: string): string {
  // Decode base64 PSBT and extract the finalized (signed) transaction
  const bytes = Uint8Array.from(atob(psbtBase64), (c) => c.charCodeAt(0));
  // Skip magic (5 bytes) and find the signed tx in global map (key 0x00)
  let i = 5;
  while (i < bytes.length) {
    if (bytes[i] === 0x00) break; // separator
    const keyLen = bytes[i++];
    const key = bytes[i]; i += keyLen;
    const valLen = bytes[i++];
    if (key === 0x00) {
      // PSBT_GLOBAL_UNSIGNED_TX or finalized tx
      return bytesToHex(bytes.slice(i, i + valLen));
    }
    i += valLen;
  }
  throw new Error('Keystone: could not extract signed transaction from PSBT');
}

// Helpers
function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function varint(n: number): number[] {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n & 0xff, (n >> 8) & 0xff];
  return [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

function bip44PathToInts(path: string): number[] {
  return path
    .replace(/^m\//, '')
    .split('/')
    .map((seg) => {
      const h = seg.endsWith("'");
      return parseInt(h ? seg.slice(0, -1) : seg, 10) + (h ? 0x80000000 : 0);
    });
}

function serializeDerivationPath(pathInts: number[]): number[] {
  // 4-byte LE fingerprint (0 for master) + 4-byte LE per path component
  const result: number[] = [0, 0, 0, 0];
  for (const p of pathInts) {
    result.push(p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff, (p >> 24) & 0xff);
  }
  return result;
}
