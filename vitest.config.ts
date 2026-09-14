// vitest.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',

    // sql.js is built for the browser: DatabaseService asks it for
    // `/sql-wasm.wasm`, which the web build serves from public/ but which
    // resolves to the filesystem root under Node. sql.js then aborts from
    // inside emscripten's own instantiation promise — a rejection no
    // .catch() on the calling side can reach. See test-support/sqlJsNode.ts.
    // Anchored to the bare specifier so the shim's own deeper import of
    // 'sql.js/dist/sql-wasm.js' is left alone.
    alias: [
      {
        find: /^sql\.js$/,
        replacement: fileURLToPath(
          new URL('./test-support/sqlJsNode.ts', import.meta.url)
        ),
      },
    ],
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
          // `enabled` defaults to false, so listing `include` alone left this
          // block inert and libauth stayed external — a deep tree of small ES
          // modules that a test can still be pulling in when its environment
          // closes:
          //   EnvironmentTeardownError: Cannot load '/node_modules/@bitauth/...'
          // That is an unhandled rejection, and so fatal under Vitest 5.
          // Prebundling collapses the tree into one file, which is both the
          // stated intent here and much cheaper than inlining it.
          enabled: true,
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
