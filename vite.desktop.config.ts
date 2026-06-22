// vite.desktop.config.ts
// Desktop-only Vite config — wraps the original vite.config.ts without modifying it.
// All Capacitor shims and Tauri-specific settings live here.
// Original source files are never touched.

import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineConfig, mergeConfig, type Plugin, type ConfigEnv, type UserConfig } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Inject desktop.css and the HTTP bridge into the build without touching main.tsx.
// The HTTP bridge is imported first so window.fetch is patched before any module
// (e.g. the price feed) issues a request.
function injectDesktopStylesPlugin(): Plugin {
  return {
    name: 'optn-inject-desktop-css',
    transform(code, id) {
      if (id.endsWith('src/main.tsx') || id.endsWith('src\\main.tsx')) {
        const cssPath = resolvePath(__dirname, 'src/platform/desktop/desktop.css');
        const httpBridgePath = resolvePath(__dirname, 'src/platform/desktop/http-bridge.ts');
        const prelude =
          `import ${JSON.stringify(httpBridgePath)};\n` +
          `import ${JSON.stringify(cssPath)};\n`;
        return { code: prelude + code, map: null };
      }
    },
  };
}

// Disable responsive breakpoints for the desktop build.
// The desktop UI is presented as a fixed-width centered column, so the mobile-first
// base layout is always the correct one. Pushing every Tailwind min-width breakpoint
// (sm/md/lg/xl/2xl) out of reach makes EVERY component (current and future) render its
// mobile layout regardless of the actual window width — no per-component fixes, nothing
// to forget. Operates on the final emitted CSS so it catches all generated breakpoints.
function neutralizeBreakpointsPlugin(): Plugin {
  return {
    name: 'optn-neutralize-breakpoints',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        const chunk = bundle[fileName];
        if (
          fileName.endsWith('.css') &&
          chunk.type === 'asset' &&
          typeof chunk.source === 'string'
        ) {
          chunk.source = chunk.source.replace(
            /min-width:\s*(640|768|1024|1280|1536)px/g,
            'min-width:999999px'
          );
        }
      }
    },
  };
}

// Desktop-specific config additions
const desktopAdditions = defineConfig({
  plugins: [
    injectDesktopStylesPlugin(),
    neutralizeBreakpointsPlugin(),
  ],
  resolve: {
    alias: {
      // Capacitor shims — transparent replacements for all @capacitor/* packages.
      // When the upstream dev adds a new Capacitor plugin, add one line here.
      '@capacitor/core': resolvePath(__dirname, 'src/platform/desktop/capacitor-core.ts'),
      '@capacitor/toast': resolvePath(__dirname, 'src/platform/desktop/toast.ts'),
      '@capacitor/barcode-scanner': resolvePath(__dirname, 'src/platform/desktop/barcode-scanner.ts'),
      '@capacitor/clipboard': resolvePath(__dirname, 'src/platform/desktop/clipboard.ts'),
      '@capacitor/filesystem': resolvePath(__dirname, 'src/platform/desktop/filesystem.ts'),
      '@capacitor/local-notifications': resolvePath(__dirname, 'src/platform/desktop/local-notifications.ts'),
      '@capacitor/dialog': resolvePath(__dirname, 'src/platform/desktop/dialog.ts'),
      '@capacitor/status-bar': resolvePath(__dirname, 'src/platform/desktop/status-bar.ts'),
      '@capacitor/splash-screen': resolvePath(__dirname, 'src/platform/desktop/splash-screen.ts'),
      '@capacitor/camera': resolvePath(__dirname, 'src/platform/desktop/camera.ts'),
    },
  },
});

export default defineConfig(async (env: ConfigEnv): Promise<UserConfig> => {
  // Dynamically load the original config so it stays fully independent
  const originalModule = await import('./vite.config.ts');
  const originalConfigOrFn = originalModule.default;

  const baseConfig: UserConfig =
    typeof originalConfigOrFn === 'function'
      ? await (originalConfigOrFn as (env: ConfigEnv) => UserConfig | Promise<UserConfig>)(env)
      : originalConfigOrFn;

  const mergedConfig = mergeConfig(baseConfig, desktopAdditions);
  return {
    ...mergedConfig,
    plugins: (mergedConfig.plugins ?? []).filter(
      (plugin) => plugin.name !== 'vite-plugin-top-level-await'
    ),
  };
});
