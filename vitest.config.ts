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

    // `coverage` and `deps` belong under `test`. They sat at the config root
    // for a long time, where Vite ignores them and Vitest never looks, so the
    // thresholds below were not a gate at all: a run reporting 39% branch
    // coverage against a floor of 50 passed without comment. They are enforced
    // now, which is why the branch number moved — it is the first measurement
    // that was ever actually checked, not a relaxation of one that was.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      thresholds: {
        // Measured from the canonical automated suite, a little under the
        // current figures so ordinary noise does not fail a run. Raise them as
        // coverage improves; do not lower them to make a red run green.
        statements: 49,
        lines: 50,
        functions: 50,
        branches: 38,
      },
      exclude: [
        'src/**/*.d.ts',
        'src/**/__tests__/**',
        'src/**/*.test.*',
        'src/**/*.spec.*',
      ],
    },

    // Vitest: prebundle for SSR (replaces deprecated test.deps.inline)
    deps: {
      optimizer: {
        ssr: {
          include: ['@bitauth/libauth', '@cashscript/utils'],
        },
      },
    },
  },

  // Also ensure vite-node doesn't externalize it during SSR. This one is a
  // Vite option and belongs at the root.
  ssr: {
    noExternal: ['@bitauth/libauth', '@cashscript/utils'],
  },
  // (Optional) cut noise from missing third-party sourcemaps
  logLevel: 'error',
});
