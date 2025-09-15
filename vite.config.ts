// vite.config.ts
import { defineConfig, loadEnv } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import topLevelAwait from 'vite-plugin-top-level-await';
import react from '@vitejs/plugin-react-swc';

export default defineConfig(({ mode }) => {
  // Load .env (both VITE_* and non-prefixed) for server-side use here
  const env = loadEnv(mode, process.cwd(), '');

  const CG_KEY = env.VITE_CG_API_KEY || env.CG_API_KEY; // CoinGecko
  const COINCAP_KEY = env.VITE_COINCAP_API_KEY || env.COINCAP_API_KEY; // CoinCap
  const CRYPTO_KEY = env.VITE_CRYPTOAPIS_KEY || env.CRYPTOAPIS_KEY; // CryptoAPIs

  return {
    plugins: [
      react(),
      nodePolyfills(),
      topLevelAwait({
        promiseExportName: '__tla',
        promiseImportName: (i) => `__tla_${i}`,
      }),
    ],
    build: {
      target: [
        'es2020',
        'chrome87',
        'safari14',
        'firefox78',
        'edge88',
        'node20',
      ],
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: {
            'sql-wasm': ['sql.js'],
          },
        },
      },
    },
    // vite.config.ts — keep everything else the same above/below
    // vite.config.ts (only server + preview shown)
    server: {
      mimeTypes: {
        'application/wasm': ['wasm'],
        'application/json': ['map'],
      },
      fs: { allow: ['..'] },
      proxy: {
        // CoinGecko (FREE/DEMO): public host + demo header
        '/coingecko': {
          target: 'https://api.coingecko.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/coingecko/, ''),
          headers: CG_KEY
            ? { 'x-cg-demo-api-key': CG_KEY, accept: 'application/json' }
            : { accept: 'application/json' },
        },

        // CoinCap (FREE): public host; key optional
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

        // CryptoAPIs: most market-data return 401/402 on free; inject if you have a key
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
    // Make preview behave like dev (so proxy also works with `vite preview`)
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
    resolve: {
      alias: {
        '/node_modules/sql.js/dist/': 'node_modules/sql.js/dist/',
      },
    },
    optimizeDeps: {
      exclude: [
        'vite-plugin-node-polyfills_shims_buffer.js',
        'react.js',
        '@cashscript_utils.js',
        'electrum-cash.js',
        '@bitauth_libauth.js',
        'reselect.js',
      ],
    },
    logLevel: 'error',
  };
});
