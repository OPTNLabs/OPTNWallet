// vite.extension.config.ts
// Browser-extension (Chrome + Firefox, MV3) build — wraps the original
// vite.config.ts without modifying it, same pattern as vite.desktop.config.ts.
//
// Scope of this build (see docs/browser-extension-scope.md): a POPUP-ONLY
// read-only wallet viewer — unlock, sync, view balances/history, and receive.
// Spending routes are not registered and TransactionService is replaced with
// a fail-closed broadcaster. There is
// deliberately NO background service worker, so MV3's service-worker-
// eviction problem (the hard part flagged in the scope doc) does not apply
// here: the popup owns its own Electrum connection only for as long as it
// stays open, exactly like a normal browser tab. Sending remains unavailable
// until its key and network lifecycle can be tested independently.

import { fileURLToPath } from 'node:url';
import { resolve as resolvePath, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  defineConfig,
  mergeConfig,
  normalizePath,
  type Plugin,
  type ConfigEnv,
  type UserConfig,
} from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = (rel: string) => normalizePath(resolvePath(__dirname, rel));

const EXTENSION_TARGET =
  process.env.EXTENSION_TARGET === 'firefox' ? 'firefox' : 'chrome';
const OUT_DIR = `dist-extension-${EXTENSION_TARGET}`;

// Swap upstream SecretCryptoService for the password-gated one. Reuses the
// EXACT SAME file the desktop build swaps in — it only touches
// WalletKeyCache (pure JS), no Tauri APIs, so it is directly reusable here.
// See vite.desktop.config.ts for why this must be a resolveId swap and not
// resolve.alias (alias keys only match raw import specifiers).
const MODULE_SWAPS = new Map<string, string>([
  [
    srcPath('src/services/SecretCryptoService.ts'),
    srcPath('src/platform/desktop/SecretCryptoService.ts'),
  ],
  [
    srcPath('src/services/TransactionService.ts'),
    srcPath('src/platform/extension/TransactionService.ts'),
  ],
]);

function extensionModuleSwapPlugin(): Plugin {
  return {
    name: 'optn-extension-module-swap',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (!resolved) return null;
      const target = MODULE_SWAPS.get(normalizePath(resolved.id));
      if (!target) return null;
      if (normalizePath(importer) === target) return null;
      return target;
    },
  };
}

// Copies the browser-specific manifest.json into the build output. Kept as
// two separate static files (extension/manifest.chrome.json /
// manifest.firefox.json) instead of one templated file, so each is a plain,
// directly-reviewable JSON document rather than generated text.
function copyManifestPlugin(): Plugin {
  return {
    name: 'optn-extension-copy-manifest',
    apply: 'build',
    closeBundle() {
      const src = resolvePath(
        __dirname,
        `extension/manifest.${EXTENSION_TARGET}.json`
      );
      const outDir = resolvePath(__dirname, OUT_DIR);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(resolvePath(outDir, 'manifest.json'), readFileSync(src));
    },
  };
}

const extensionAdditions = defineConfig({
  plugins: [
    extensionModuleSwapPlugin(),
    // tiny-secp256k1 (used by RpaService) loads its .wasm via the ESM-wasm-
    // proposal `import wasm from './x.wasm'` syntax, which Vite doesn't
    // support natively — same reasoning as vite.desktop.config.ts.
    wasm(),
    topLevelAwait(),
    copyManifestPlugin(),
  ],
  optimizeDeps: {
    // Same two general (not Tauri-specific) rolldown/esbuild issues the
    // desktop config works around: cashscript's nested @cashscript/utils
    // copy is missing an export under rolldown's strict mode, and
    // tiny-secp256k1's wasm loader must not be pre-bundled by esbuild.
    exclude: ['cashscript', 'tiny-secp256k1'],
    include: ['semver'],
  },
  resolve: {
    dedupe: ['@cashscript/utils'],
  },
});

export default defineConfig(async (env: ConfigEnv): Promise<UserConfig> => {
  const originalModule = await import('./vite.config.ts');
  const originalConfigOrFn = originalModule.default;
  const baseConfig: UserConfig =
    typeof originalConfigOrFn === 'function'
      ? await (
          originalConfigOrFn as (
            env: ConfigEnv
          ) => UserConfig | Promise<UserConfig>
        )(env)
      : originalConfigOrFn;

  const merged = mergeConfig(baseConfig, extensionAdditions);

  // MV3 extensions require a fairly recent Chrome/Firefox just to install at
  // all — not the old Android WebView the base es2020 target is pinned for.
  // mergeConfig CONCATENATES target arrays, so the conservative entries
  // would otherwise survive and break the wasm/top-level-await output (same
  // failure mode documented in vite.desktop.config.ts). Hard-replace it.
  merged.build = {
    ...(merged.build ?? {}),
    target: 'chrome110',
    outDir: OUT_DIR,
    emptyOutDir: true,
    rollupOptions: {
      ...(merged.build?.rollupOptions ?? {}),
      input: resolvePath(__dirname, 'popup.html'),
    },
  };
  merged.esbuild = { ...(merged.esbuild ?? {}), target: 'chrome110' };
  merged.base = './';
  return merged;
});
