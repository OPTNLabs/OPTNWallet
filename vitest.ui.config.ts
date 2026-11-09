import { defineConfig, mergeConfig } from 'vitest/config';

import baseConfig from './vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: [
        'src/platform/desktop/__tests__/ui/**/*.ui.test.tsx',
        'src/features/transaction/components/__tests__/**/*.ui.test.tsx',
        'src/components/ui/__tests__/**/*.ui.test.tsx',
        'src/components/__tests__/**/*.ui.test.tsx',
        'src/features/contract-view/__tests__/**/*.ui.test.tsx',
        'src/features/transaction-history/__tests__/**/*.ui.test.tsx',
        'src/features/simple-send/__tests__/**/*.ui.test.tsx',
        'src/features/multisig/__tests__/**/*.ui.test.tsx',
        'src/pages/__tests__/**/*.ui.test.tsx',
        'src/hooks/__tests__/**/*.ui.test.tsx',
      ],
    },
  })
);
