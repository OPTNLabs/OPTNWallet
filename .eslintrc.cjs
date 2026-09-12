module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: [
    'dist',
    '.eslintrc.cjs',
    // wasm-bindgen owns this directory; lint the hand-written loader instead.
    'src/wasm/optn-core/generated',
  ],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  overrides: [
    {
      files: [
        'src/pages/apps/MarketplaceAppHost.tsx',
        'src/pages/apps/airdrops/services/executeAirdropDistributionSend.ts',
        'src/pages/apps/cauldron/CauldronSwapApp.tsx',
        'src/pages/apps/fundme/CampaignDetail.tsx',
        'src/pages/apps/fundme/cashstarterPledge.ts',
        'src/pages/apps/fundme/fundmeTransactions.ts',
        'src/pages/apps/mint-cashtokens-poc/MintCashTokensPoCApp.tsx',
        'src/pages/apps/patient0/AuthGuardApp.tsx',
        'src/services/AddonsSDK.ts',
      ],
      rules: {
        '@typescript-eslint/ban-ts-comment': 'off',
      },
    },
  ],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
};
