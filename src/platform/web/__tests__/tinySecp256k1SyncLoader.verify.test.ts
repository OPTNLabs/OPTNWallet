import { describe, expect, it } from 'vitest';
import * as secp256k1 from 'tiny-secp256k1';
import syncLoaderExports from '../tinySecp256k1SyncLoader';

// Verifies the synchronous loader's instantiated WASM exports are
// byte-identical in behavior to the real tiny-secp256k1 package (whatever
// loading path it uses in this test environment) -- the actual compiled
// module is the same binary either way, so any divergence here means the
// custom loader's import wiring or memory layout assumptions are wrong.
// Delete this file once the sync loader has shipped in a build without
// incident for a while; it exists purely to catch loader bugs before they
// reach RpaService's real key derivation.
describe('tinySecp256k1SyncLoader (verification against the real package)', () => {
  const wasm = syncLoaderExports as {
    memory: WebAssembly.Memory;
    initializeContext: () => void;
    PRIVATE_INPUT: WebAssembly.Global;
    pointFromScalar: (outputLen: number) => number;
  };

  it('exposes the same public API shape as the real package (memory, globals, functions)', () => {
    expect(wasm.memory).toBeInstanceOf(WebAssembly.Memory);
    expect(wasm.PRIVATE_INPUT).toBeInstanceOf(WebAssembly.Global);
    expect(typeof wasm.initializeContext).toBe('function');
    expect(typeof wasm.pointFromScalar).toBe('function');
  });

  it('derivePublicKeyCompressed matches the real tiny-secp256k1 package for the same private key', () => {
    wasm.initializeContext();

    const privateKey = new Uint8Array(32);
    // Fixed, non-zero test scalar -- must be < curve order, this value is safely small.
    privateKey[31] = 7;

    // Real package's own computation (whatever loader this environment gives it).
    const expectedPubkey = secp256k1.pointFromScalar(privateKey, true);
    expect(expectedPubkey).not.toBeNull();

    // Same computation via the custom sync loader's raw wasm exports, using
    // the exact same memory-layout contract index.js relies on.
    const buffer = new Uint8Array(wasm.memory.buffer);
    const privateInputPtr = wasm.PRIVATE_INPUT.value;
    buffer.set(privateKey, privateInputPtr);
    // Real calling convention (index.js's own pointFromScalar wrapper):
    // pass the desired output length, get back a 1/0 success flag, then
    // read the result out of PUBLIC_KEY_INPUT -- not a computed length.
    const outputLen = 33;
    const status = wasm.pointFromScalar(outputLen);
    expect(status).toBe(1);

    const wasmAny = syncLoaderExports as unknown as Record<string, WebAssembly.Global>;
    const publicKeyInputPtr = wasmAny.PUBLIC_KEY_INPUT.value;
    const actualPubkey = buffer.slice(publicKeyInputPtr, publicKeyInputPtr + outputLen);

    expect(Buffer.from(actualPubkey).toString('hex')).toBe(
      Buffer.from(expectedPubkey!).toString('hex')
    );
  });
});
