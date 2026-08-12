// vitest.config.ts
import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // e2e/ specs run only via WebdriverIO (`npm run test:e2e`), not vitest —
    // they use wdio/mocha globals (describe/it with a different runtime),
    // and vitest's default include glob would otherwise pick up
    // e2e/specs/*.spec.ts and try to execute them directly, which fails.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
  // Vitest v3: prebundle for SSR (replaces deprecated test.deps.inline)
  deps: {
    optimizer: {
      ssr: {
        include: ['@bitauth/libauth', '@cashscript/utils'],
      },
    },
  },
  // Also ensure vite-node doesn't externalize it during SSR
  ssr: {
    noExternal: ['@bitauth/libauth', '@cashscript/utils'],
  },
  // (Optional) cut noise from missing third-party sourcemaps
  logLevel: 'error',
});
