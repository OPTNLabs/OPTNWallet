/**
 * Copies bytes into an ArrayBuffer-backed view for Web APIs whose DOM types
 * require ArrayBuffer rather than the broader ArrayBufferLike union.
 */
export function toArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}
