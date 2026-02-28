// vite.config.ts
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));

import { defineConfig, loadEnv } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';
import react from '@vitejs/plugin-react-swc';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

function buildApiProxy(
  cgKey?: string,
  coincapKey?: string,
  cryptoKey?: string
) {
  return {
    '/coingecko': {
      target: 'https://api.coingecko.com',
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/coingecko/, ''),
      headers: (() => {
        const headers: Record<string, string> = {
          accept: 'application/json',
        };
        if (cgKey) headers['x-cg-demo-api-key'] = cgKey;
        return headers;
      })(),
    },
    '/coincap': {
      target: 'https://api.coincap.io',
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/coincap/, ''),
      headers: (() => {
        const headers: Record<string, string> = {
          accept: 'application/json',
        };
        if (coincapKey) headers['Authorization'] = `Bearer ${coincapKey}`;
        return headers;
      })(),
    },
    '/cryptoapi': {
      target: 'https://rest.cryptoapis.io',
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/cryptoapi/, ''),
      headers: (() => {
        const headers: Record<string, string> = {
          accept: 'application/json',
        };
        if (cryptoKey) headers['x-api-key'] = cryptoKey;
        return headers;
      })(),
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const CG_KEY = env.VITE_CG_API_KEY || env.CG_API_KEY;
  const COINCAP_KEY = env.VITE_COINCAP_API_KEY || env.COINCAP_API_KEY;
  const CRYPTO_KEY = env.VITE_CRYPTOAPIS_KEY || env.CRYPTOAPIS_KEY;
  const apiProxy = buildApiProxy(CG_KEY, COINCAP_KEY, CRYPTO_KEY);

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
      proxy: apiProxy,
    },
    preview: {
      proxy: apiProxy,
    },
    logLevel: 'error',
  };
});
