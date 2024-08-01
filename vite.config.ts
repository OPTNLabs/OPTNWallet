import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import topLevelAwait from 'vite-plugin-top-level-await';
import react from '@vitejs/plugin-react-swc';

export default defineConfig({
  plugins: [
    react(), // React plugin configuration with SWC
    nodePolyfills(), // Plugin for Node.js polyfills
    topLevelAwait({
      // Configuration for handling top-level await
      promiseExportName: '__tla',
      promiseImportName: (i) => `__tla_${i}`,
    }),
  ],
  build: {
    target: ['es2020', 'chrome87', 'safari14', 'firefox78', 'edge88', 'node20'],
    rollupOptions: {
      output: {
        manualChunks: {
          'sql-wasm': ['sql.js'],
        },
      },
    },
  },
  server: {
    mimeTypes: {
      'application/wasm': ['wasm'],
    },
    fs: {
      allow: ['..'], // Allow serving files from one level up to handle node_modules
    },
  },
  resolve: {
    alias: {
      '/node_modules/sql.js/dist/': 'node_modules/sql.js/dist/',
    },
  },
});
