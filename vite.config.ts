// vite.config.ts
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));

import { defineConfig, normalizePath, type Plugin } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

type RollupWarning = {
  code?: string;
  id?: string;
  message?: string;
};

// tiny-secp256k1 (used by RpaService) loads its .wasm via the ESM-wasm-
// proposal `import * as wasm from "./secp256k1.wasm"` syntax, which needs a
// plugin pair (vite-plugin-wasm + vite-plugin-top-level-await) that this
// base config deliberately doesn't carry — its output can't be downleveled
// to the conservative target array below (needed for old Android WebView
// compatibility), which is the root cause of the mobile/web production
// build currently failing on this package. Redirect to a loader that
// instantiates the EXACT SAME .wasm binary synchronously instead
// (WebAssembly.Module/Instance are synchronous constructors when the bytes
// are already in memory, avoiding the need for top-level await at all) --
// see src/platform/web/tinySecp256k1SyncLoader.ts for the full explanation
// and src/platform/web/__tests__/tinySecp256k1SyncLoader.verify.test.ts for
// the correctness check against the real package. Desktop/extension builds
// inherit this too (mergeConfig concatenates plugin arrays) -- harmless,
// since it's the same verified-correct output; their own wasm()/
// topLevelAwait() plugins simply have nothing left to do for this package.
function tinySecp256k1SyncLoaderPlugin(): Plugin {
  const targetPath = normalizePath(resolvePath(__dirname, 'src/platform/web/tinySecp256k1SyncLoader.ts'));
  return {
    name: 'optn-tiny-secp256k1-sync-loader',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const normalized = normalizePath(resolved.id);
      if (!normalized.endsWith('tiny-secp256k1/lib/wasm_loader.browser.js')) return null;
      if (normalizePath(importer) === targetPath) return null;
      return targetPath;
    },
  };
}

export default defineConfig(({ mode }) => {
  const BROWSER_CONDITIONS = ['browser', 'module', 'import', 'default'];

  return {
    base: mode === 'development' ? '/' : './',
    // Vite 8 / rolldown enforces stricter CommonJS interop, which makes some CJS
    // default imports resolve to a namespace object → React "element type is invalid"
    // (#130) → blank screen. Restore Rollup's permissive interop.
    legacy: { inconsistentCjsInterop: true },
    plugins: [
      react(),
      nodePolyfills({
        protocolImports: true,
        globals: { process: true, Buffer: true },
      }),
      tinySecp256k1SyncLoaderPlugin(),
    ],
    resolve: {
      alias: {
        '/node_modules/sql.js/dist/': 'node_modules/sql.js/dist/',
        net: resolvePath(__dirname, 'src/shim/net.ts'),
        tls: resolvePath(__dirname, 'src/shim/tls.ts'),
      },
      conditions: BROWSER_CONDITIONS,
    },
    define: {
      'process.env': {},
      global: 'window',
    },
    optimizeDeps: {
      include: ['@electrum-cash/network', '@electrum-cash/web-socket'],
      esbuildOptions: {
        define: { global: 'window', 'process.env': '{}' },
        conditions: BROWSER_CONDITIONS,
        mainFields: ['browser', 'module', 'main'],
      },
      exclude: [
        'vite-plugin-node-polyfills_shims_buffer.js',
        'react.js',
        '@cashscript_utils.js',
        'electrum-cash.js',
        '@bitauth_libauth.js',
        'reselect.js',
        '@electrum-cash/network',
        '@electrum-cash/web-socket',
      ],
    },
    build: {
      target: ['es2020', 'chrome87', 'safari14', 'firefox78', 'edge88'],
      sourcemap: true,
      rollupOptions: {
        // ✅ suppress only the specific warnings you’re seeing
        onwarn(warning, warn) {
          const { id = '' } = warning as RollupWarning;

          // vm-browserify eval warning
          if (warning.code === 'EVAL' && String(id).includes('vm-browserify')) {
            return;
          }

          // ox PURE annotation positioning warning
          if (
            (warning.code === 'PURE_ANNOTATION' ||
              String(warning.message || '').includes(
                'contains an annotation'
              )) &&
            String(id).includes('node_modules/ox/')
          ) {
            return;
          }

          warn(warning);
        },
        output: {
          manualChunks: (id) => (id.includes('sql.js') ? 'sql-wasm' : undefined),
        },
      },
    },
    server: {
      mimeTypes: {
        'application/wasm': ['wasm'],
        'application/json': ['map'],
      },
      watch: {
        // Ignore generated trees and test-only directories so Vite does not
        // exhaust inotify watchers during web dev.
        ignored: [
          '**/android/**',
          '**/__tests__/**',
          '**/*.test.*',
          '**/*.spec.*',
        ],
        usePolling: process.platform === 'linux',
        interval: 250,
      },
      fs: { allow: ['..'] },
    },
    logLevel: 'error',
  };
});
