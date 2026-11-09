import { describe, expect, it } from 'vitest';
import {
  getPreparedTinySecp256k1Wasm,
  prepareTinySecp256k1Wasm,
} from '../tinySecp256k1Wasm';

describe('tiny-secp256k1 WASM preparation', () => {
  it('instantiates asynchronously before consumers load and reuses the instance', async () => {
    expect(getPreparedTinySecp256k1Wasm()).toBeUndefined();

    const prepared = await prepareTinySecp256k1Wasm();

    expect(prepared).toBeInstanceOf(WebAssembly.Instance);
    expect(getPreparedTinySecp256k1Wasm()).toBe(prepared);
    expect(await prepareTinySecp256k1Wasm()).toBe(prepared);
  });
});
