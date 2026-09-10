// Bindings are generated from the same Rust crate used by native consumers.
// Synchronous loading also works in older mobile WebViews and extension pages.
import { initSync } from './generated/optn_core.js';
import { OPTN_CORE_WASM_BASE64 } from './generated/optnCoreWasmBase64.generated';

const bytes = Uint8Array.from(atob(OPTN_CORE_WASM_BASE64), (byte) =>
  byte.charCodeAt(0)
);
initSync({ module: bytes });

export {
  connectP2pkhLock,
  connectPublicKey,
  connectSignInput,
  connectSignP2pkh,
  connectSigningSerialization,
} from './generated/optn_core.js';
