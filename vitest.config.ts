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
  coverage: {
    provider: 'v8',
    reporter: ['text', 'text-summary', 'json-summary'],
    thresholds: {
      // Baseline measured from the canonical automated suite. These floors
      // make coverage regressions visible without pretending that untested
      // native surfaces are covered by Node/Vitest tests.
      statements: 45,
      lines: 45,
      functions: 40,
      branches: 50,
    },
    exclude: [
      'src/**/*.d.ts',
      'src/**/__tests__/**',
      'src/**/*.test.*',
      'src/**/*.spec.*',
    ],
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
