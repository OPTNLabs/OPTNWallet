import {
  bigIntToVmNumber,
  binToHex,
  createVirtualMachineBch2026,
  hexToBin,
  vmNumberToBigInt,
  type AuthenticationProgramCommon,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';

export type NftFieldEncoding =
  | {
      type:
        | 'binary'
        | 'boolean'
        | 'hex'
        | 'https-url'
        | 'ipfs-cid'
        | 'utf8'
        | 'locktime';
    }
  | {
      type: 'number';
      aggregate?: 'add';
      decimals?: number;
      unit?: string;
    };

export type NftParseType = {
  name: string;
  description?: string;
  fields?: string[];
  uris?: Record<string, string>;
};

export type NftParseField = {
  name?: string;
  description?: string;
  encoding: NftFieldEncoding;
};

export type NftParseInfo = {
  bytecode: string;
  types: Record<string, NftParseType>;
  fields?: Record<string, NftParseField>;
};

export type NftParsedValue =
  | {
      type: 'number';
      value: bigint;
      formatted: string;
      decimals?: number;
      unit?: string;
      aggregate?: string;
    }
  | { type: 'utf8'; formatted: string }
  | { type: 'boolean'; value: boolean; formatted: string }
  | { type: 'binary'; formatted: string }
  | { type: 'hex'; formatted: string }
  | { type: 'https-url'; url: string; formatted: string }
  | { type: 'ipfs-cid'; cid: string; formatted: string }
  | { type: 'locktime'; formatted: string; blockHeight?: number; timestamp?: number };

export type ParsedNftField = {
  fieldId?: string;
  name?: string;
  description?: string;
  value: string;
  parsedValue?: NftParsedValue;
};

export type NftParseSuccess = {
  success: true;
  nftTypeKey: string;
  nftTypeName?: string;
  nftTypeDescription?: string;
  nftTypeUris?: Record<string, string>;
  fields: ParsedNftField[];
  altstackHex: string[];
};

export type NftParseFailure = {
  success: false;
  error: string;
};

export type NftParseResult = NftParseSuccess | NftParseFailure;

export type NftUtxoLike = {
  commitment: string;
  valueSatoshis?: bigint;
  lockingBytecode?: Uint8Array;
};

const nftParsingVm = createVirtualMachineBch2026();

const LOCKTIME_BLOCK_THRESHOLD = 500_000_000n;

function stackItemToHex(item: Uint8Array | string): string {
  return typeof item === 'string' ? item : binToHex(item);
}

function decodeVmNumber(bytes: Uint8Array): bigint {
  const strict = vmNumberToBigInt(bytes, {
    maximumVmNumberByteLength: 256,
    requireMinimalEncoding: true,
  });
  if (typeof strict !== 'string') {
    return strict;
  }

  if (bytes.length === 0) {
    return 0n;
  }

  let result = 0n;
  const lastByte = bytes[bytes.length - 1];
  if (lastByte === undefined) {
    return 0n;
  }
  const isNegative = (lastByte & 0x80) !== 0;

  for (let i = 0; i < bytes.length; i += 1) {
    const rawByte = bytes[i];
    if (rawByte === undefined) {
      break;
    }
    const byte =
      i === bytes.length - 1 && isNegative ? rawByte & 0x7f : rawByte;
    result |= BigInt(byte) << BigInt(i * 8);
  }

  return isNegative ? -result : result;
}

function formatDecimal(value: bigint, decimals: number): string {
  if (decimals <= 0) {
    return value.toString();
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const fraction = abs % divisor;
  let out = `${whole}.${fraction.toString().padStart(decimals, '0')}`;
  out = out.replace(/\.?0+$/, '');
  if (out === '') {
    out = '0';
  }
  if (negative && out !== '0') {
    out = `-${out}`;
  }
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function parseFieldValue(
  fieldValueHex: string,
  encoding: NftFieldEncoding
): NftParsedValue {
  if (encoding.type === 'boolean') {
    if (fieldValueHex === '01') {
      return { type: 'boolean', value: true, formatted: 'true' };
    }
    if (fieldValueHex === '00') {
      return { type: 'boolean', value: false, formatted: 'false' };
    }
    throw new Error(
      'Invalid boolean field value: must be exactly 0x00 or 0x01.'
    );
  }

  switch (encoding.type) {
    case 'number': {
      const value = decodeVmNumber(hexToBin(fieldValueHex));
      const decimals = encoding.decimals ?? 0;
      let formatted = formatDecimal(value, decimals);
      if (encoding.unit) {
        formatted = `${formatted} ${encoding.unit}`;
      }
      const out: NftParsedValue = {
        type: 'number',
        value,
        formatted,
        decimals,
      };
      if (encoding.unit) out.unit = encoding.unit;
      if (encoding.aggregate) out.aggregate = encoding.aggregate;
      return out;
    }
    case 'utf8': {
      return { type: 'utf8', formatted: decodeUtf8(hexToBin(fieldValueHex)) };
    }
    case 'binary': {
      const binary = Array.from(hexToBin(fieldValueHex))
        .map((byte) => byte.toString(2).padStart(8, '0'))
        .join('');
      return { type: 'binary', formatted: binary ? `0b${binary}` : '0b0' };
    }
    case 'hex': {
      return { type: 'hex', formatted: fieldValueHex ? `0x${fieldValueHex}` : '0x00' };
    }
    case 'https-url': {
      const percentEncoded = decodeUtf8(hexToBin(fieldValueHex));
      const decoded = decodeURIComponent(percentEncoded);
      const url = `https://${decoded}`;
      return { type: 'https-url', url, formatted: url };
    }
    case 'ipfs-cid': {
      const cid = decodeUtf8(hexToBin(fieldValueHex));
      const formatted = `ipfs://${cid}`;
      return { type: 'ipfs-cid', cid, formatted };
    }
    case 'locktime': {
      const locktime = Number(decodeVmNumber(hexToBin(fieldValueHex)));
      if (locktime < LOCKTIME_BLOCK_THRESHOLD) {
        return {
          type: 'locktime',
          formatted: `Block ${locktime}`,
          blockHeight: locktime,
        };
      }
      const date = new Date(locktime * 1000);
      return {
        type: 'locktime',
        formatted: date.toISOString(),
        timestamp: locktime,
      };
    }
    default:
      throw new Error(`Unsupported field encoding: ${JSON.stringify(encoding)}`);
  }
}

function isMinimalPositiveVmNumber(bytes: Uint8Array): bigint | undefined {
  const decoded = vmNumberToBigInt(bytes, {
    maximumVmNumberByteLength: 256,
    requireMinimalEncoding: true,
  });
  if (typeof decoded === 'string') {
    return undefined;
  }
  return decoded > 0n ? decoded : undefined;
}

function isMinimalEncoding(bytes: Uint8Array): boolean {
  const decoded = vmNumberToBigInt(bytes, {
    maximumVmNumberByteLength: 256,
    requireMinimalEncoding: true,
  });
  return typeof decoded !== 'string';
}

function minimalEncodingOf(value: bigint): Uint8Array {
  return bigIntToVmNumber(value);
}

export function nftTickerSymbol(
  categorySymbol: string,
  typeKeyHex: string
): string {
  const symbol = categorySymbol.trim();
  const keyBytes = hexToBin(typeKeyHex);
  if (keyBytes.length === 0) {
    return `${symbol}-0`;
  }
  const positive = isMinimalPositiveVmNumber(keyBytes);
  if (positive !== undefined) {
    return `${symbol}-${positive.toString()}`;
  }
  return `${symbol}-X${typeKeyHex.toUpperCase()}`;
}

function resolveNftType(
  typeKeyHex: string,
  fieldsHex: string[],
  parseInfo: NftParseInfo
): NftParseResult {
  const typeDefinition = parseInfo.types[typeKeyHex];
  if (!typeDefinition) {
    return {
      success: false,
      error: `No NFT type definition found for type key "${typeKeyHex}".`,
    };
  }

  const namedFields: ParsedNftField[] = fieldsHex.map((fieldHex, index) => {
    const fieldId = typeDefinition.fields?.[index];
    const fieldDefinition = fieldId ? parseInfo.fields?.[fieldId] : undefined;
    const out: ParsedNftField = {
      value: fieldHex,
    };
    if (fieldId) {
      out.fieldId = fieldId;
    }
    if (fieldDefinition?.name) {
      out.name = fieldDefinition.name;
    }
    if (fieldDefinition?.description) {
      out.description = fieldDefinition.description;
    }
    if (fieldDefinition?.encoding) {
      try {
        out.parsedValue = parseFieldValue(fieldHex, fieldDefinition.encoding);
      } catch (error) {
        throw new Error(
          `Failed to parse field "${
            fieldDefinition.name ?? fieldId ?? String(index)
          }": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return out;
  });

  const result: NftParseSuccess = {
    success: true,
    nftTypeKey: typeKeyHex,
    fields: namedFields,
    altstackHex: [typeKeyHex, ...fieldsHex],
  };
  if (typeDefinition.name) {
    result.nftTypeName = typeDefinition.name;
  }
  if (typeDefinition.description) {
    result.nftTypeDescription = typeDefinition.description;
  }
  if (typeDefinition.uris) {
    result.nftTypeUris = typeDefinition.uris;
  }
  return result;
}

export function parseNftCommitment(
  utxo: NftUtxoLike,
  parseInfo: NftParseInfo
): NftParseResult {
  const commitment = utxo.commitment.trim();
  if (!/^[0-9a-f]*$/i.test(commitment) || commitment.length % 2 !== 0) {
    return { success: false, error: 'Invalid NFT commitment hex.' };
  }

  const bytecodeHex = parseInfo.bytecode.trim();
  let bytecode: Uint8Array;
  try {
    bytecode = hexToBin(bytecodeHex);
  } catch {
    return { success: false, error: 'Invalid parse bytecode hex.' };
  }
  if (bytecode.length === 0) {
    return {
      success: false,
      error: 'Parsable NFT categories require non-empty parse bytecode.',
    };
  }

  const nftOutput: Output = {
    lockingBytecode: utxo.lockingBytecode ?? new Uint8Array(0),
    valueSatoshis: utxo.valueSatoshis ?? 0n,
    token: {
      category: new Uint8Array(32),
      amount: 0n,
      nft: {
        capability: 'none',
        commitment: hexToBin(commitment),
      },
    },
  };
  const parseOutput: Output = {
    lockingBytecode: bytecode,
    valueSatoshis: 0n,
  };
  const sourceOutputs: Output[] = [nftOutput, parseOutput];

  const parsingTransaction: TransactionCommon = {
    version: 2,
    inputs: [
      {
        outpointIndex: 0,
        outpointTransactionHash: new Uint8Array(32),
        sequenceNumber: 0,
        unlockingBytecode: new Uint8Array(0),
      },
      {
        outpointIndex: 0,
        outpointTransactionHash: new Uint8Array(32),
        sequenceNumber: 0,
        unlockingBytecode: hexToBin('51'),
      },
    ],
    outputs: [
      {
        lockingBytecode: hexToBin('6a'),
        valueSatoshis: 0n,
      },
    ],
    locktime: 0,
  };

  const program: AuthenticationProgramCommon = {
    inputIndex: 1,
    sourceOutputs,
    transaction: parsingTransaction,
  };

  const finalState = nftParsingVm.evaluate(program);
  if (finalState.error !== undefined) {
    return { success: false, error: `VM evaluation failed: ${finalState.error}` };
  }
  if (finalState.alternateStack.length === 0) {
    return {
      success: false,
      error: 'Parse bytecode produced an empty altstack.',
    };
  }

  const altstackHex = finalState.alternateStack.map((item) => stackItemToHex(item));
  const typeKeyHex = altstackHex[0];
  if (typeKeyHex === undefined) {
    return { success: false, error: 'Parse bytecode produced no type key.' };
  }
  const fieldsHex = altstackHex.slice(1);

  try {
    return resolveNftType(typeKeyHex, fieldsHex, parseInfo);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function lookupSequentialNftType(
  commitment: string,
  parseInfo: NftParseInfo
): NftParseResult {
  const normalized = commitment.trim().toLowerCase();
  if (!/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) {
    return { success: false, error: 'Invalid NFT commitment hex.' };
  }
  try {
    return resolveNftType(normalized, [], parseInfo);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isMinimalVmNumberEncoding(hexValue: string): boolean {
  return isMinimalEncoding(hexToBin(hexValue));
}

export function minimallyEncodeVmNumber(value: bigint): string {
  return binToHex(minimalEncodingOf(value));
}
