// Test-only sql.js loader.
// Keep this out of src so no application bundle can reach node:module.
//
// DatabaseService asks sql.js for `/sql-wasm.wasm` — an absolute URL that the
// web build serves out of public/. Under vitest the environment is Node, so
// that same string resolves against the filesystem root and sql.js aborts:
//
//   RuntimeError: Aborted(Error: ENOENT ... open '/sql-wasm.wasm')
//
// Emscripten raises that from its own instantiation promise, not from the one
// initSqlJs() hands back, so no .catch() on the calling side can absorb it —
// which is why the existing `.catch(() => undefined)` guards around these
// paths did not help. Vitest 3 tolerated the stray rejection; Vitest 5 fails
// the run on it, and that is how three long-standing leaks surfaced at once as
// a red web-ci rather than as anything new.
//
// vitest.config.ts aliases the bare specifier `sql.js` to this file, so tests
// that genuinely exercise the database get the wasm actually shipped in
// node_modules. Tests that vi.doMock('sql.js') themselves still win: the alias
// only decides what the real module resolves to.
/* eslint-env node */
import { createRequire } from 'node:module';
// The alias is anchored to the bare specifier, so this deeper path is not
// rewritten and does not recurse back into this file.
import initSqlJs from 'sql.js/dist/sql-wasm.js';

const requireFromHere = createRequire(import.meta.url);

type SqlJsConfig = Record<string, unknown> & {
  locateFile?: (file: string) => string;
};

export default function initSqlJsFromNodeModules(
  config: SqlJsConfig = {}
): Promise<unknown> {
  return (initSqlJs as (c: SqlJsConfig) => Promise<unknown>)({
    ...config,
    // Deliberately overrides whatever the caller passed: under Node there is
    // no server to serve a browser path from, so honouring it only aborts.
    locateFile: (file: string) =>
      requireFromHere.resolve(`sql.js/dist/${file}`),
  });
}
