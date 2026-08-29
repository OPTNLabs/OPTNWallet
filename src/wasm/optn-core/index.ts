// The wallet's handle on crates/optn-core, the shared Rust protocol core.
//
// RPA used to be implemented twice — once here in TypeScript for every GUI
// target, once in Rust for the CLI — with no shared code, so a change to one
// was not a change to the other and the two could drift in silence. This is the
// path by which the TypeScript side stops being a second implementation.
//
// Everything under generated/ is produced by scripts/build-optn-core-wasm.mts
// and should not be hand-edited. This file is the hand-written part.
//
// Loading is synchronous, following the pattern already proven here by
// src/platform/web/tinySecp256k1SyncLoader.ts and for the same reason: the
// conservative build target needed by old Android WebViews cannot downlevel
// vite-plugin-top-level-await's output, which is what broke the mobile and web
// production builds before. WebAssembly.Module and WebAssembly.Instance are
// synchronous constructors once the bytes are in memory, so the binary is
// base64-embedded and instantiated up front. No top-level await, no plugin,
// nothing for the bundler to downlevel.
//
// Correctness oracle: test-vectors/rpa.json — the same file the Rust and
// TypeScript suites read. If this binding is wrong, optnCore.verify.test.ts
// stops matching.
import { initSync } from './generated/optn_core';
import { OPTN_CORE_WASM_BASE64 } from './generated/optnCoreWasmBase64.generated';

export * from './generated/optn_core';

function decodeBase64(base64: string): Uint8Array {
  // atob in browsers and WebViews, Buffer under Node where vitest runs. Both
  // are synchronous, which is the whole point.
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeBuffer = (globalThis as any).Buffer;
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(base64, 'base64'));
  throw new Error('no base64 decoder available (neither atob nor Buffer)');
}

let ready = false;

/**
 * Instantiate the core. Safe to call repeatedly; later calls are no-ops.
 *
 * Exported because a screen about to perform several RPA operations may prefer
 * to pay the instantiation cost once, up front, rather than on first use.
 */
export function ensureOptnCore(): void {
  if (ready) return;
  initSync({ module: decodeBase64(OPTN_CORE_WASM_BASE64) });
  ready = true;
}
