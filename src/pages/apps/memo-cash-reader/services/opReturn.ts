import { hexToBin } from '@bitauth/libauth';

export type ParsedPushData = {
  pushes: Uint8Array[];
  bytesRead: number;
};

function readLittleEndianLength(bytes: Uint8Array, from: number, width: 2 | 4) {
  if (from + width > bytes.length) {
    throw new Error('Malformed script: truncated pushdata length');
  }

  let out = 0;
  for (let i = 0; i < width; i += 1) {
    out |= bytes[from + i] << (8 * i);
  }
  return out;
}

export function stripHexPrefix(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\\x/i, '')
    .replace(/^0x/i, '');
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse push operations in a script segment.
 * Supports direct pushes and OP_PUSHDATA{1,2,4}.
 * Non-push opcodes throw by default (strict mode).
 */
export function parsePushOnlyScript(
  scriptBytes: Uint8Array,
  startIndex = 0,
  allowOp0 = false
): ParsedPushData {
  const pushes: Uint8Array[] = [];
  let i = startIndex;

  while (i < scriptBytes.length) {
    const opcode = scriptBytes[i];
    i += 1;

    if (allowOp0 && opcode === 0x00) {
      pushes.push(new Uint8Array());
      continue;
    }

    let dataLength = 0;
    if (opcode >= 0x01 && opcode <= 0x4b) {
      dataLength = opcode;
    } else if (opcode === 0x4c) {
      if (i >= scriptBytes.length) {
        throw new Error('Malformed script: truncated OP_PUSHDATA1');
      }
      dataLength = scriptBytes[i];
      i += 1;
    } else if (opcode === 0x4d) {
      dataLength = readLittleEndianLength(scriptBytes, i, 2);
      i += 2;
    } else if (opcode === 0x4e) {
      dataLength = readLittleEndianLength(scriptBytes, i, 4);
      i += 4;
    } else {
      throw new Error(
        `Unsupported opcode in push-only parser: 0x${opcode.toString(16)}`
      );
    }

    if (i + dataLength > scriptBytes.length) {
      throw new Error('Malformed script: push exceeds remaining bytecode');
    }

    pushes.push(scriptBytes.slice(i, i + dataLength));
    i += dataLength;
  }

  return { pushes, bytesRead: i - startIndex };
}

/**
 * Parse an OP_RETURN script and return pushdata chunks.
 */
export function parseOpReturnPushes(lockingBytecodeHex: string): Uint8Array[] {
  const hex = stripHexPrefix(lockingBytecodeHex);
  if (!hex) throw new Error('Empty locking bytecode');

  const bytes = hexToBin(hex);
  if (bytes.length === 0 || bytes[0] !== 0x6a) {
    throw new Error('Not an OP_RETURN script');
  }

  return parsePushOnlyScript(bytes, 1, false).pushes;
}

/**
 * Parse an unlocking script and return pushdata chunks.
 * This is used to extract pubkeys from P2PKH unlockers.
 */
export function parseUnlockingPushes(unlockingBytecodeHex: string): Uint8Array[] {
  const hex = stripHexPrefix(unlockingBytecodeHex);
  if (!hex) return [];
  const bytes = hexToBin(hex);
  return parsePushOnlyScript(bytes, 0, true).pushes;
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function reverseHexBytes(hex: string): string {
  const clean = stripHexPrefix(hex);
  if (clean.length % 2 !== 0) return clean;

  let out = '';
  for (let i = clean.length; i > 0; i -= 2) {
    out += clean.slice(i - 2, i);
  }
  return out;
}
