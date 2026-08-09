// Desktop shim for sql.js — bypasses Vite/rolldown bundling which breaks
// Emscripten's onRuntimeInitialized callback chain.
// Loads the browser UMD build via <script> tag so the WASM runtime runs
// exactly as compiled, then proxies the same initSqlJs API.


// Minimal type stubs so DatabaseService.ts's `Database` annotation works.
// (TSC is not run during `tauri dev`; esbuild strips these at build time.)
export interface Database {
  run(sql: string, params?: unknown[]): Database;
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  prepare(sql: string): unknown;
  export(): Uint8Array;
  close(): void;
  getRowsModified(): number;
}
export interface SqlJsStatic {
  Database: new (data?: ArrayLike<number> | null) => Database;
}

interface InitSqlJsConfig {
  locateFile?: (filename: string, prefix?: string) => string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    initSqlJs?: (config?: InitSqlJsConfig) => Promise<SqlJsStatic>;
  }
}

let loadPromise: Promise<void> | null = null;

function loadSqlJsScript(): Promise<void> {
  if (loadPromise) return loadPromise;
  if (window.initSqlJs) {
    loadPromise = Promise.resolve();
    return loadPromise;
  }
  loadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    // Served verbatim from public/ on purpose. This is a CLASSIC script: its
    // top-level `var initSqlJs` only becomes a global when the file is delivered
    // untouched. Importing it as `sql.js/dist/sql-wasm.js?url` instead routes a
    // node_modules file through Vite, which does not guarantee that, and the
    // load then fails with "loaded without initSqlJs".
    script.src = '/sql-wasm-browser.js';
    script.onload = () => {
      if (window.initSqlJs) resolve();
      else reject(new Error('sql.js browser runtime loaded without initSqlJs'));
    };
    script.onerror = () =>
      reject(new Error('Failed to load the sql.js browser runtime'));
    document.head.appendChild(script);
  });
  return loadPromise;
}

async function initSqlJs(config?: InitSqlJsConfig): Promise<SqlJsStatic> {
  console.log('[sql-js-shim] initSqlJs called — loading browser UMD');
  await loadSqlJsScript();
  console.log('[sql-js-shim] script ready, calling window.initSqlJs');
  if (!window.initSqlJs)
    throw new Error('initSqlJs not available after script load');
  // Always use the browser WASM paired with the browser runtime.
  // Upstream passes locateFile: () => '/sql-wasm.wasm' which points to the Node.js build
  // (wrong WASM for the browser UMD) — we override it here regardless of caller config.
  const result = await window.initSqlJs({
    ...config,
    locateFile: (_file: string) => {
      void _file;
      return '/sql-wasm-browser.wasm';
    },
  });
  console.log('[sql-js-shim] SQL module ready');
  return result;
}

export default initSqlJs;
