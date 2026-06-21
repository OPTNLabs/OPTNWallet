// vite.desktop.config.ts
// Desktop-only Vite config — wraps the original vite.config.ts without modifying it.
// All Capacitor shims and Tauri-specific settings live here.
// Original source files are never touched.

import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineConfig, mergeConfig, type Plugin, type ConfigEnv, type UserConfig } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Inject desktop.css into the build without touching main.tsx
function injectDesktopStylesPlugin(): Plugin {
  return {
    name: 'optn-inject-desktop-css',
    transform(code, id) {
      if (id.endsWith('src/main.tsx') || id.endsWith('src\\main.tsx')) {
        const cssPath = resolvePath(__dirname, 'src/platform/desktop/desktop.css');
        return { code: `import ${JSON.stringify(cssPath)};\n` + code, map: null };
      }
    },
  };
}

// Stub the quantumroot JSON that hasn't been committed to the dev branch yet.
// This prevents build errors — the Quantumroot feature itself is in-progress upstream.
function stubMissingReferencesPlugin(): Plugin {
  const QUANTUMROOT_STUB = JSON.stringify({
    $schema: 'https://bitauth.com/schemas/authentication-template-v0.schema.json',
    description: 'Quantumroot Schnorr LM-OTS Vault (dev stub)',
    name: 'Quantumroot Schnorr LM-OTS Vault',
    supported: ['BCH_2025_05'],
    version: 0,
    entities: {},
    scripts: {},
    scenarios: {},
  });

  return {
    name: 'optn-stub-missing-references',
    resolveId(id: string) {
      if (id.includes('quantumroot-schnorr-lm-ots-vault')) {
        return '\0virtual:quantumroot-stub';
      }
    },
    load(id: string) {
      if (id === '\0virtual:quantumroot-stub') {
        return `export default ${QUANTUMROOT_STUB};`;
      }
    },
  };
}

// Desktop-specific config additions
const desktopAdditions = defineConfig({
  plugins: [injectDesktopStylesPlugin(), stubMissingReferencesPlugin()],
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

  return mergeConfig(baseConfig, desktopAdditions);
});
