// The desktop prelude must run before any library or app module, and the
// webview must not reach the network around the Rust bridges.
//
// Three things in vite.desktop.config.ts keep it that way, and none fails
// loudly when lost, because each breaks release builds only:
// - The network bridges load before any library that captures `WebSocket`.
//   Lost, relay sockets keep the webview's own and the CSP blocks them.
// - The storage partition loads before the redux store opens localForage.
//   Lost, every window shares one persist database.
// - The dev server sends the release CSP. Lost, a bypass works in
//   development and fails only after release.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizePath, type Plugin, type UserConfig } from 'vite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridge = (name: string) =>
  normalizePath(resolve(repoRoot, 'src', 'platform', 'desktop', name));

async function desktopConfig(): Promise<UserConfig> {
  const { default: config } = await import('../../vite.desktop.config.ts');
  return (config as (env: object) => Promise<UserConfig>)({
    command: 'build',
    mode: 'production',
    isSsrBuild: false,
    isPreview: false,
  });
}

function flatPlugins(config: UserConfig): Plugin[] {
  return (config.plugins ?? []).flat(Infinity as 1).filter(Boolean) as Plugin[];
}

describe('desktop prelude', () => {
  it('gives the prelude a chunk of its own, so it runs before any library or app chunk', async () => {
    const config = await desktopConfig();
    const output = config.build?.rollupOptions?.output;
    expect(output && !Array.isArray(output)).toBe(true);
    const manualChunks = (
      output as { manualChunks: (id: string, meta: unknown) => unknown }
    ).manualChunks;
    for (const name of [
      'network-prelude.ts',
      'http-bridge.ts',
      'socket-bridge.ts',
      'rendererNetwork.ts',
      'storagePartition.ts',
    ]) {
      expect(manualChunks(bridge(name), {}), name).toBe('desktop-prelude');
    }
    for (const other of [
      resolve(
        repoRoot,
        'node_modules',
        'nostr-tools',
        'lib',
        'esm',
        'index.js'
      ),
      resolve(repoRoot, 'src', 'state', 'store.ts'),
    ]) {
      expect(manualChunks(normalizePath(other), {}), other).not.toBe(
        'desktop-prelude'
      );
    }
  }, 60_000);

  it('imports the bridges, then the storage partition, before anything else in main.tsx', async () => {
    const config = await desktopConfig();
    const inject = flatPlugins(config).find(
      (plugin) => plugin.name === 'optn-inject-desktop-css'
    );
    const transform = inject?.transform as
      | ((code: string, id: string) => { code: string } | undefined)
      | undefined;
    const result = transform?.call(
      {},
      'export {};',
      resolve(repoRoot, 'src', 'main.tsx')
    );
    expect(result?.code.split('\n').slice(0, 2)).toEqual([
      `import ${JSON.stringify(bridge('network-prelude.ts'))};`,
      `import ${JSON.stringify(bridge('storagePartition.ts'))};`,
    ]);
  }, 60_000);

  it('serves the release CSP in development, except the inline HMR preamble', async () => {
    const config = await desktopConfig();
    const release = (
      JSON.parse(
        readFileSync(resolve(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8')
      ) as { app: { security: { csp: string } } }
    ).app.security.csp;
    const dev = (config.server?.headers as Record<string, string>)[
      'Content-Security-Policy'
    ];
    const withoutScripts = (csp: string) => csp.replace(/script-src [^;]*/, '');
    expect(withoutScripts(dev)).toBe(withoutScripts(release));
    // Neither lets the webview open a remote connection or image itself.
    for (const csp of [release, dev]) {
      const directive = (name: string) =>
        csp
          .split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${name} `)) ?? '';
      expect(directive('connect-src')).not.toMatch(
        /(^|\s)(https?:|wss?:)(\s|$)/
      );
      expect(directive('connect-src')).not.toMatch(
        /https:\/\/(?!ipc\.localhost)/
      );
      expect(directive('connect-src')).not.toMatch(/wss:/);
      expect(directive('img-src')).not.toMatch(/https?:/);
    }
  }, 60_000);
});
