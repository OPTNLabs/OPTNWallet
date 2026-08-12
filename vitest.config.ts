// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
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
