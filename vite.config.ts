import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import topLevelAwait from 'vite-plugin-top-level-await';
import react from '@vitejs/plugin-react-swc';

// https://vitejs.dev/config/
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
  },
});
