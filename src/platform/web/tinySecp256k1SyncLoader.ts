// Drop-in replacement for tiny-secp256k1/lib/wasm_loader.browser.js, used
// only by the mobile/web build (see vite.config.ts's resolve.alias) where
// the conservative build target can't downlevel vite-plugin-top-level-await's
// output (the desktop build doesn't need this -- it targets a modern
// WebView2/Chromium engine and uses the plugin pair directly).
//
// tiny-secp256k1's index.js accesses the loaded module's exports
// SYNCHRONOUSLY at module-evaluation time (`const WASM_BUFFER = new
// Uint8Array(wasm.memory.buffer)`), which is why the upstream loader needs
// the ESM-wasm-import-proposal syntax (`import * as wasm from
// "./secp256k1.wasm"`) plus a plugin that downlevels its implicit top-level
// await. This file gets the same result without ANY top-level await:
// WebAssembly.Module/Instance are synchronous constructors when the wasm
// bytes are already in memory, so base64-embedding the exact same .wasm
// binary (see secp256k1WasmBase64.generated.ts) and decoding it up front
// avoids needing an async fetch/compile step at all.
//
// Same compiled WASM binary as desktop uses -- only the JS-side loading
// mechanism differs. src/services/__tests__/RpaService.test.ts's existing
// test vectors are the correctness oracle: if this loader is wrong, those
// keys/pubkeys stop matching.
import { SECP256K1_WASM_BASE64 } from './secp256k1WasmBase64.generated';

// tiny-secp256k1's own rand.browser.js / validate_error.js implementations,
// reproduced here rather than deep-imported -- its package.json `exports`
// map only exposes the "." entry point, so `tiny-secp256k1/lib/*.js` isn't
// an importable (or version-guaranteed) path. Both are tiny and copied
// verbatim from the installed package (see node_modules/tiny-secp256k1/lib/
// rand.browser.js and validate_error.js) so there's nothing to drift.
function generateInt32(): number {
  const bytes = new Uint8Array(4);
  if (typeof crypto === 'undefined') {
    throw new Error('The crypto object is unavailable. This may occur if your environment does not support the Web Cryptography API.');
  }
  crypto.getRandomValues(bytes);
  return (bytes[0] << (3 * 8)) + (bytes[1] << (2 * 8)) + (bytes[2] << (1 * 8)) + bytes[3];
}

const ERROR_MESSAGES: Record<number, string> = {
  0: 'Expected Private',
  1: 'Expected Point',
  2: 'Expected Tweak',
  3: 'Expected Hash',
  4: 'Expected Signature',
  5: 'Expected Extra Data (32 bytes)',
  6: 'Expected Parity (1 | 0)',
  7: 'Bad Recovery Id',
};
function throwError(errcode: number): void {
  throw new TypeError(ERROR_MESSAGES[errcode] ?? `Unknow error code: ${errcode}`);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const wasmBytes = base64ToBytes(SECP256K1_WASM_BASE64);
const wasmModule = new WebAssembly.Module(wasmBytes);
const instance = new WebAssembly.Instance(wasmModule, {
  './rand.js': { generateInt32 },
  './validate_error.js': { throwError },
});

export default instance.exports;
