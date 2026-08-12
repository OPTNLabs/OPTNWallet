// vite.config.ts
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));

import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';
import react from '@vitejs/plugin-react-swc';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig(({ mode }) => {
  const BROWSER_CONDITIONS = ['browser', 'module', 'import', 'default'];

  return {
    base: mode === 'development' ? '/' : './',
    plugins: [
      react(),
      topLevelAwait({
        promiseExportName: '__tla',
        promiseImportName: (i) => `__tla_${i}`,
      }),
      nodePolyfills({
        protocolImports: true,
        globals: { process: true, Buffer: true },
      }),
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
          const id = (warning as any)?.id ?? '';

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
          manualChunks: { 'sql-wasm': ['sql.js'] },
        },
      },
    },
    server: {
      mimeTypes: {
        'application/wasm': ['wasm'],
        'application/json': ['map'],
      },
      fs: { allow: ['..'] },
    },
    logLevel: 'error',
  };
});
