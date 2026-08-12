export function ensureUint8Array(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input;

  if (typeof input === 'string' && input.startsWith('<Uint8Array: 0x')) {
    const hex = input.slice('<Uint8Array: 0x'.length, -1);
    const bytes = new Uint8Array(Math.floor(hex.length / 2));
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  }

  if (Array.isArray(input)) return Uint8Array.from(input as number[]);
  return new Uint8Array();
}

export function parseSatoshis(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim()) {
    if (value.startsWith('<bigint:')) {
      const match = value.match(/^<bigint:\s*(\d+)n>$/);
      if (match) return BigInt(match[1]);
    }
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}
