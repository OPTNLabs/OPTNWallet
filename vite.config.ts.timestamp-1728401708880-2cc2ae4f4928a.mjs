// vite.config.ts
import { defineConfig } from "file:///home/lightswarm/projects/OPTNWallet/node_modules/vite/dist/node/index.js";
import { nodePolyfills } from "file:///home/lightswarm/projects/OPTNWallet/node_modules/vite-plugin-node-polyfills/dist/index.js";
import topLevelAwait from "file:///home/lightswarm/projects/OPTNWallet/node_modules/vite-plugin-top-level-await/exports/import.mjs";
import react from "file:///home/lightswarm/projects/OPTNWallet/node_modules/@vitejs/plugin-react-swc/index.mjs";
var vite_config_default = defineConfig({
  plugins: [
    react(),
    // React plugin configuration with SWC
    nodePolyfills(),
    // Plugin for Node.js polyfills
    topLevelAwait({
      // Configuration for handling top-level await
      promiseExportName: "__tla",
      promiseImportName: (i) => `__tla_${i}`
    })
  ],
  build: {
    target: ["es2020", "chrome87", "safari14", "firefox78", "edge88", "node20"],
    rollupOptions: {
      output: {
        manualChunks: {
          "sql-wasm": ["sql.js"]
        }
      }
    }
  },
  server: {
    mimeTypes: {
      "application/wasm": ["wasm"]
    },
    fs: {
      allow: [".."]
      // Allow serving files from one level up to handle node_modules
    }
  },
  resolve: {
    alias: {
      "/node_modules/sql.js/dist/": "node_modules/sql.js/dist/"
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvaG9tZS9saWdodHN3YXJtL3Byb2plY3RzL09QVE5XYWxsZXRcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9ob21lL2xpZ2h0c3dhcm0vcHJvamVjdHMvT1BUTldhbGxldC92aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vaG9tZS9saWdodHN3YXJtL3Byb2plY3RzL09QVE5XYWxsZXQvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlJztcbmltcG9ydCB7IG5vZGVQb2x5ZmlsbHMgfSBmcm9tICd2aXRlLXBsdWdpbi1ub2RlLXBvbHlmaWxscyc7XG5pbXBvcnQgdG9wTGV2ZWxBd2FpdCBmcm9tICd2aXRlLXBsdWdpbi10b3AtbGV2ZWwtYXdhaXQnO1xuaW1wb3J0IHJlYWN0IGZyb20gJ0B2aXRlanMvcGx1Z2luLXJlYWN0LXN3Yyc7XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHBsdWdpbnM6IFtcbiAgICByZWFjdCgpLCAvLyBSZWFjdCBwbHVnaW4gY29uZmlndXJhdGlvbiB3aXRoIFNXQ1xuICAgIG5vZGVQb2x5ZmlsbHMoKSwgLy8gUGx1Z2luIGZvciBOb2RlLmpzIHBvbHlmaWxsc1xuICAgIHRvcExldmVsQXdhaXQoe1xuICAgICAgLy8gQ29uZmlndXJhdGlvbiBmb3IgaGFuZGxpbmcgdG9wLWxldmVsIGF3YWl0XG4gICAgICBwcm9taXNlRXhwb3J0TmFtZTogJ19fdGxhJyxcbiAgICAgIHByb21pc2VJbXBvcnROYW1lOiAoaSkgPT4gYF9fdGxhXyR7aX1gLFxuICAgIH0pLFxuICBdLFxuICBidWlsZDoge1xuICAgIHRhcmdldDogWydlczIwMjAnLCAnY2hyb21lODcnLCAnc2FmYXJpMTQnLCAnZmlyZWZveDc4JywgJ2VkZ2U4OCcsICdub2RlMjAnXSxcbiAgICByb2xsdXBPcHRpb25zOiB7XG4gICAgICBvdXRwdXQ6IHtcbiAgICAgICAgbWFudWFsQ2h1bmtzOiB7XG4gICAgICAgICAgJ3NxbC13YXNtJzogWydzcWwuanMnXSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbiAgc2VydmVyOiB7XG4gICAgbWltZVR5cGVzOiB7XG4gICAgICAnYXBwbGljYXRpb24vd2FzbSc6IFsnd2FzbSddLFxuICAgIH0sXG4gICAgZnM6IHtcbiAgICAgIGFsbG93OiBbJy4uJ10sIC8vIEFsbG93IHNlcnZpbmcgZmlsZXMgZnJvbSBvbmUgbGV2ZWwgdXAgdG8gaGFuZGxlIG5vZGVfbW9kdWxlc1xuICAgIH0sXG4gIH0sXG4gIHJlc29sdmU6IHtcbiAgICBhbGlhczoge1xuICAgICAgJy9ub2RlX21vZHVsZXMvc3FsLmpzL2Rpc3QvJzogJ25vZGVfbW9kdWxlcy9zcWwuanMvZGlzdC8nLFxuICAgIH0sXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBOFIsU0FBUyxvQkFBb0I7QUFDM1QsU0FBUyxxQkFBcUI7QUFDOUIsT0FBTyxtQkFBbUI7QUFDMUIsT0FBTyxXQUFXO0FBRWxCLElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVM7QUFBQSxJQUNQLE1BQU07QUFBQTtBQUFBLElBQ04sY0FBYztBQUFBO0FBQUEsSUFDZCxjQUFjO0FBQUE7QUFBQSxNQUVaLG1CQUFtQjtBQUFBLE1BQ25CLG1CQUFtQixDQUFDLE1BQU0sU0FBUyxDQUFDO0FBQUEsSUFDdEMsQ0FBQztBQUFBLEVBQ0g7QUFBQSxFQUNBLE9BQU87QUFBQSxJQUNMLFFBQVEsQ0FBQyxVQUFVLFlBQVksWUFBWSxhQUFhLFVBQVUsUUFBUTtBQUFBLElBQzFFLGVBQWU7QUFBQSxNQUNiLFFBQVE7QUFBQSxRQUNOLGNBQWM7QUFBQSxVQUNaLFlBQVksQ0FBQyxRQUFRO0FBQUEsUUFDdkI7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLFFBQVE7QUFBQSxJQUNOLFdBQVc7QUFBQSxNQUNULG9CQUFvQixDQUFDLE1BQU07QUFBQSxJQUM3QjtBQUFBLElBQ0EsSUFBSTtBQUFBLE1BQ0YsT0FBTyxDQUFDLElBQUk7QUFBQTtBQUFBLElBQ2Q7QUFBQSxFQUNGO0FBQUEsRUFDQSxTQUFTO0FBQUEsSUFDUCxPQUFPO0FBQUEsTUFDTCw4QkFBOEI7QUFBQSxJQUNoQztBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
