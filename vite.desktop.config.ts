// vite.desktop.config.ts
// Desktop-only Vite config — wraps the original vite.config.ts without modifying it.
// All Capacitor shims and Tauri-specific settings live here.
// Original source files are never touched.

import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineConfig, mergeConfig, normalizePath, type Plugin, type ConfigEnv, type UserConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Alias keys MUST be in Vite's normalized (forward-slash) form: on Windows,
// resolvePath() returns backslash paths, but the resolver compares module ids
// posix-normalized, so a raw backslash key silently never matches — the same
// separator trap injectDesktopStylesPlugin() below guards against with its
// dual endsWith checks. srcPath() is the one true way to build alias keys here.
const srcPath = (rel: string) => normalizePath(resolvePath(__dirname, rel));

// Vite may append a query to an importer/resolved module id (for example while
// transforming an HMR request). Module swaps are source-file decisions, so a
// query must never make the desktop wrapper look different from its own target.
// Without stripping it, DesktopAppShell's import of the real AppShell is
// rewritten back to DesktopAppShell and React recurses until the WebView stalls.
const modulePath = (id: string) => normalizePath(id.replace(/[?#].*$/, ''));

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
        const loggerPath = resolvePath(__dirname, 'src/platform/desktop/logger.ts');
        // Must run BEFORE state/store.ts configures localForage, so per-window
        // storage partitioning is in place when the persist store is created.
        const storagePartitionPath = resolvePath(__dirname, 'src/platform/desktop/storagePartition.ts');
        const prelude =
          `import ${JSON.stringify(storagePartitionPath)};\n` +
          `import ${JSON.stringify(httpBridgePath)};\n` +
          `import ${JSON.stringify(cssPath)};\n` +
          `import { initLogger } from ${JSON.stringify(loggerPath)}; initLogger();\n`;
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

// Swap upstream modules for their desktop replacements.
//
// This is deliberately NOT resolve.alias: alias `find` keys are matched against
// the RAW import specifier (e.g. '../services/SecretCryptoService'), so an
// absolute-path key never matches a relative import and the swap silently does
// nothing (this exact failure shipped once — the gate/onboarding/crypto swaps
// were all dead in dev while a stale process made them look alive). Resolving
// first and then comparing normalized absolute paths cannot miss, regardless of
// how the importing file spells its specifier.
const MODULE_SWAPS = new Map<string, string>([
  // Upstream SecretCryptoService keeps its AES key in localStorage; the desktop
  // one only uses the RAM key placed by the security gate / wallet-open flow.
  [srcPath('src/services/SecretCryptoService.ts'), srcPath('src/platform/desktop/SecretCryptoService.ts')],
  // Gates seed-phrase reveal behind the app-lock PIN prompt on desktop.
  [srcPath('src/services/DeviceIntegrityService.ts'), srcPath('src/platform/desktop/DeviceIntegrityService.ts')],
  // Reads installed 'iframe-bundle' addon source from <AppData>/addons/ —
  // desktop-only (no filesystem-drop UX equivalent on mobile yet).
  [srcPath('src/services/addons/AddonInstallService.ts'), srcPath('src/platform/desktop/AddonInstallService.ts')],
  // CashFusion needs a raw TCP+TLS socket, which no WebView can open — the
  // desktop version routes through a Rust command that speaks the real protocol.
  [srcPath('src/services/fusion/FusionStatusService.ts'), srcPath('src/platform/desktop/FusionStatusService.ts')],
  // Backend router: with a BIP37 node pinned, wallet data is served from a
  // trustless node scan instead of Electrum (one backend at a time). The router
  // imports the real ElectrumServer for the auto/server path — allowed because
  // resolveId short-circuits when the replacement itself is the importer.
  [srcPath('src/apis/ElectrumServer/ElectrumServer.ts'), srcPath('src/platform/desktop/ElectrumServerRouter.ts')],
  // Home screen with a network-aware balance unit: chipnet/testnet read "tBCH",
  // mainnet reads "BCH" (via the shared unitFor). AppShell imports Home directly
  // from src/features/home/Home, so that's the swap target.
  [srcPath('src/features/home/Home.tsx'), srcPath('src/platform/desktop/DesktopHome.tsx')],
  // Mounts DesktopSecurityGate + AppLockGate + menu-bar listener around the app.
  [srcPath('src/app/AppShell.tsx'), srcPath('src/platform/desktop/DesktopAppShell.tsx')],
  // Electron Cash-style onboarding: wallet picker, per-wallet passwords, seed
  // re-confirmation, hardware wallet as a top-level choice. Keys are the
  // src/pages/* paths because that is what AppShell.tsx's imports resolve to
  // (the pages are thin re-export shims over src/features/onboarding/*).
  [srcPath('src/pages/RootHandler.tsx'), srcPath('src/platform/desktop/onboarding/DesktopRootHandler.tsx')],
  [srcPath('src/pages/onboarding/LandingPage.tsx'), srcPath('src/platform/desktop/onboarding/DesktopLandingPage.tsx')],
  [srcPath('src/pages/onboarding/CreateWalletPage.tsx'), srcPath('src/platform/desktop/onboarding/DesktopCreateWalletPage.tsx')],
  [srcPath('src/pages/onboarding/ImportWalletPage.tsx'), srcPath('src/platform/desktop/onboarding/DesktopImportWalletPage.tsx')],
]);

/** Emscripten sql.js replacement. Swapped on an exact specifier only. */
const SQL_JS_SHIM = resolvePath(
  __dirname,
  'src/platform/desktop/sql-js-shim.ts'
);

function desktopModuleSwapPlugin(): Plugin {
  return {
    name: 'optn-desktop-module-swap',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // sql.js must be swapped on an EXACT specifier, not through resolve.alias.
      // A string alias key matches `id === key` OR `id.startsWith(key + '/')`,
      // so an alias would also capture the shim's own
      // `sql.js/dist/sql-wasm.js?url` and rewrite it to
      // `<shim>/dist/sql-wasm.js?url`, which does not exist — the alias eats the
      // very import meant to escape it, and the desktop app fails to boot.
      if (source === 'sql.js') return SQL_JS_SHIM;
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const target = MODULE_SWAPS.get(modulePath(resolved.id));
      if (!target) return null;
      // When the replacement module itself imports the original (e.g.
      // DesktopAppShell imports the real AppShell), let it through untouched —
      // otherwise the swap would point the module at itself.
      if (modulePath(importer) === target) return null;
      return target;
    },
  };
}

// Desktop-specific config additions
const desktopAdditions = defineConfig({
  // A concurrent web Vite process must not invalidate desktop's optimized
  // chunks (or vice versa).
  cacheDir: resolvePath(__dirname, 'node_modules/.vite-desktop'),
  plugins: [
    desktopModuleSwapPlugin(),
    // tiny-secp256k1 (used by RpaService) loads its .wasm via the ESM-wasm-proposal
    // `import wasm from './x.wasm'` syntax, which Vite doesn't support natively.
    // These two plugins add that support; order matters (wasm before top-level-await).
    wasm(),
    topLevelAwait(),
    injectDesktopStylesPlugin(),
    neutralizeBreakpointsPlugin(),
  ],
  optimizeDeps: {
    // cashscript: nested @cashscript/utils copy missing generateRedeemScript in rolldown strict mode.
    // semver: CJS-only, pre-bundled via esbuild to get a proper ESM wrapper.
    // sql.js: bypasses optimizeDeps entirely — aliased to src/platform/desktop/sql-js-shim.ts,
    //         which loads the Emscripten browser UMD build via <script> tag to avoid
    //         rolldown/esbuild mangling of the onRuntimeInitialized callback chain.
    // tiny-secp256k1: its wasm loader must not be pre-bundled by esbuild (which can't
    //         handle the wasm import either); let vite-plugin-wasm handle it directly.
    exclude: ['cashscript', 'tiny-secp256k1'],
    include: ['semver'],
  },
  resolve: {
    // Force a single instance of @cashscript/utils so cashscript's nested copy
    // (which is missing generateRedeemScript) is never resolved.
    dedupe: ['@cashscript/utils'],
    alias: {
      // NOTE: source-file swaps (SecretCryptoService, AppShell gate, onboarding
      // pages, etc.) live in desktopModuleSwapPlugin() above — NOT here. Alias
      // keys only match raw import specifiers, so absolute-path keys silently
      // never fire. Only bare package specifiers belong in this block.

      // sql.js is NOT aliased here — see SQL_JS_SHIM in desktopModuleSwapPlugin.
      // A prefix-matching alias would also capture the shim's own
      // `sql.js/dist/...` import and break the desktop boot.

      // Native TCP(+TLS) Electrum transport. The web build can only open
      // WebSockets, but most Fulcrum servers expose only the raw TCP-SSL port
      // (50002); this desktop replacement speaks that via a Rust command so the
      // full server ecosystem is reachable. Same class/interface, so
      // @electrum-cash/network is unchanged.
      '@electrum-cash/web-socket': resolvePath(__dirname, 'src/platform/desktop/electrum-web-socket.ts'),

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

  const merged = mergeConfig(baseConfig, desktopAdditions);

  // The desktop bundle runs in Tauri's WebView2 (modern Chromium/Edge), not the
  // old mobile WebViews the base es2020 target is pinned for. mergeConfig
  // CONCATENATES the target arrays, so the conservative es2020/edge88 entries
  // survive and make esbuild fail ("cannot transform destructuring to es2020").
  // Hard-REPLACE the target with a single modern one — safe on desktop only.
  merged.build = { ...(merged.build ?? {}), target: 'chrome110' };
  merged.esbuild = { ...(merged.esbuild ?? {}), target: 'chrome110' };
  return merged;
});
