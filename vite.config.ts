// vite.config.ts
import { defineConfig, loadEnv } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import topLevelAwait from 'vite-plugin-top-level-await';
import react from '@vitejs/plugin-react-swc';

export default defineConfig(({ mode }) => {
  // Load .env (both VITE_* and non-prefixed) for server-side use here
  const env = loadEnv(mode, process.cwd(), '');

  const CG_KEY      = env.VITE_CG_API_KEY      || env.CG_API_KEY;        // CoinGecko
  const COINCAP_KEY = env.VITE_COINCAP_API_KEY || env.COINCAP_API_KEY;   // CoinCap
  const CRYPTO_KEY  = env.VITE_CRYPTOAPIS_KEY  || env.CRYPTOAPIS_KEY;    // CryptoAPIs

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
      target: ['es2020', 'chrome87', 'safari14', 'firefox78', 'edge88', 'node20'],
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
    server: {
      mimeTypes: {
        'application/wasm': ['wasm'],
        'application/json': ['map'],
      },
      fs: { allow: ['..'] },
      proxy: {
        // CoinGecko
        '/coingecko': {
          target: 'https://pro-api.coingecko.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/coingecko/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              // Use the env values captured by loadEnv()
              if (CG_KEY) {
                proxyReq.setHeader('x-cg-demo-api-key', CG_KEY);
                proxyReq.setHeader('x-cg-pro-api-key', CG_KEY); // harmless if demo; improves compatibility
              }
              proxyReq.setHeader('accept', 'application/json');
            });
          },
        },

        // CoinCap (REST host)
        '/coincap': {
          target: 'https://rest.coincap.io',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/coincap/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (COINCAP_KEY) {
                proxyReq.setHeader('Authorization', `Bearer ${COINCAP_KEY}`);
              }
              proxyReq.setHeader('accept', 'application/json');
            });
          },
        },

        // CryptoAPIs
        '/cryptoapi': {
          target: 'https://rest.cryptoapis.io',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/cryptoapi/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (CRYPTO_KEY) {
                proxyReq.setHeader('x-api-key', CRYPTO_KEY);
              }
              proxyReq.setHeader('accept', 'application/json');
            });
          },
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
