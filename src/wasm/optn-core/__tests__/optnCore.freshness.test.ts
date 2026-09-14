// Is the committed wasm artifact still the Rust source it was built from?
//
// `src/wasm/optn-core/generated/` is checked in, because the wallet bundles the
// module inline rather than fetching it. That means the artifact and the crate
// can drift: add an export to crates/optn-core/src/wasm.rs, forget
// `npm run wasm:optn-core`, and the wallet keeps running the previous build.
//
// Nothing detects that. The verify test next door only exercises exports that
// already exist, so a missing one makes it pass by not being called, and the
// failure surfaces later as `undefined is not a function` at runtime — in the
// one place the whole shared-core effort exists to make trustworthy.
//
// Comparing export NAMES rather than bytes is deliberate. wasm builds are not
// reliably byte-identical across toolchains, so a checksum here would fail for
// reasons that have nothing to do with the code; the name set is what actually
// breaks a caller.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const RUST_SOURCE = 'crates/optn-core/src/wasm.rs';
const GENERATED_TYPES = 'src/wasm/optn-core/generated/optn_core.d.ts';

/** Every `#[wasm_bindgen(js_name = X)]` the crate declares. */
function declaredInRust(): string[] {
  const source = readFileSync(RUST_SOURCE, 'utf8');
  return [...source.matchAll(/js_name\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((match) => match[1])
    .sort();
}

/** Every function the generated bindings actually expose. */
function presentInArtifact(): string[] {
  const types = readFileSync(GENERATED_TYPES, 'utf8');
  return [...types.matchAll(/^export function ([A-Za-z_][A-Za-z0-9_]*)/gm)]
    .map((match) => match[1])
    .sort();
}

describe('generated optn-core wasm bindings', () => {
  it('exposes every export the crate declares', () => {
    const declared = declaredInRust();
    const present = new Set(presentInArtifact());
    const missing = declared.filter((name) => !present.has(name));

    expect(
      missing,
      `crates/optn-core/src/wasm.rs declares ${missing.length} export(s) the ` +
        'committed artifact does not have, so the artifact is stale. ' +
        'Rebuild it with `npm run wasm:optn-core` and commit the result.'
    ).toEqual([]);
  });

  it('finds exports on both sides at all', () => {
    // Guards the check above from passing vacuously: if either regex stopped
    // matching — a wasm-bindgen output format change, say — `missing` would be
    // empty and the test would report health it never verified.
    expect(declaredInRust().length).toBeGreaterThan(0);
    expect(presentInArtifact().length).toBeGreaterThan(0);
  });
});
