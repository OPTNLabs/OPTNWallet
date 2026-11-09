// Drop-in replacement for tiny-secp256k1/lib/wasm_loader.browser.js.
//
// tiny-secp256k1 reads its WASM exports synchronously at module evaluation,
// while WebViews reject synchronous compilation/instantiation of this module
// on the UI thread. Startup asynchronously instantiates the same embedded WASM
// bytes before importing the application graph; this loader then returns the
// prepared instance without compiling or instantiating again.
//
// The fallback preserves direct use in Node-based parity tests and desktop
// targets. React startup prepares the instance before loading this module.
import {
  getPreparedTinySecp256k1Wasm,
  tinySecp256k1Imports,
} from './tinySecp256k1Wasm';
import { SECP256K1_WASM_BASE64 } from './secp256k1WasmBase64.generated';
import { toArrayBufferBytes } from '../../utils/arrayBuffer';

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const preparedInstance = getPreparedTinySecp256k1Wasm();
const instance =
  preparedInstance ??
  new WebAssembly.Instance(
    new WebAssembly.Module(
      toArrayBufferBytes(base64ToBytes(SECP256K1_WASM_BASE64))
    ),
    tinySecp256k1Imports
  );

export default instance.exports;
