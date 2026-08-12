export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}
