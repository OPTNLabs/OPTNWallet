// vite.config.ts
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));

import { defineConfig, loadEnv } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';
import react from '@vitejs/plugin-react-swc';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const CG_KEY = env.VITE_CG_API_KEY || env.CG_API_KEY;
  const COINCAP_KEY = env.VITE_COINCAP_API_KEY || env.COINCAP_API_KEY;
  const CRYPTO_KEY = env.VITE_CRYPTOAPIS_KEY || env.CRYPTOAPIS_KEY;

  // Prefer browser entry points everywhere (resolver + prebundler).
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
        net: resolvePath(__dirname, 'src/shims/net.ts'),
        tls: resolvePath(__dirname, 'src/shims/tls.ts'),
      },
      conditions: BROWSER_CONDITIONS,
    },
    define: {
      // Make sure any `process.env.X` access does not crash at runtime.
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
      proxy: {
        '/coingecko': {
          target: 'https://api.coingecko.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/coingecko/, ''),
          headers: (() => {
            const headers: Record<string, string> = {
              accept: 'application/json',
            };
            if (CG_KEY) headers['x-cg-demo-api-key'] = CG_KEY;
            return headers;
          })(),
        },
        '/coincap': {
          target: 'https://api.coincap.io',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/coincap/, ''),
          headers: (() => {
            const headers: Record<string, string> = {
              accept: 'application/json',
            };
            if (COINCAP_KEY) headers['Authorization'] = `Bearer ${COINCAP_KEY}`;
            return headers;
          })(),
        },
        '/cryptoapi': {
          target: 'https://rest.cryptoapis.io',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/cryptoapi/, ''),
          headers: (() => {
            const headers: Record<string, string> = {
              accept: 'application/json',
            };
            if (CRYPTO_KEY) headers['x-api-key'] = CRYPTO_KEY;
            return headers;
          })(),
        },
      },
    },
    preview: {
      proxy: {
        '/coingecko': {
          target: 'https://api.coingecko.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/coingecko/, ''),
          headers: CG_KEY
            ? { 'x-cg-demo-api-key': CG_KEY, accept: 'application/json' }
            : { accept: 'application/json' },
        },
        '/coincap': {
          target: 'https://api.coincap.io',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/coincap/, ''),
          headers: COINCAP_KEY
            ? {
                Authorization: `Bearer ${COINCAP_KEY}`,
                accept: 'application/json',
              }
            : { accept: 'application/json' },
        },
        '/cryptoapi': {
          target: 'https://rest.cryptoapis.io',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/cryptoapi/, ''),
          headers: CRYPTO_KEY
            ? { 'x-api-key': CRYPTO_KEY, accept: 'application/json' }
            : { accept: 'application/json' },
        },
      },
    },
    logLevel: 'error',
  };
});
