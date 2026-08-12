// src/addons/builtin/index.ts
import type { AddonManifest } from '../../types/addons';

/**
 * Keep this list small. These are "shipped with the app" addons.
 * Marketplace-installed addons will be loaded later from storage.
 */
export const BUILTIN_ADDONS: AddonManifest[] = [
  {
    id: 'optn.builtin.demo',
    name: 'OPTN Builtin Demo',
    version: '0.0.1',
    description: 'Builtin addon scaffold to validate addon contract loading.',
    trustTier: 'internal',
    permissions: [
      {
        kind: 'capabilities',
        capabilities: [
          'wallet:context:read',
          'wallet:addresses:read',
          'utxo:wallet:read',
          'chain:query',
          'tx:add_output',
          'tx:build',
          'tx:broadcast',
          'http:fetch_json',
        ],
      },
      {
        kind: 'http',
        domains: ['chaingraph.optnlabs.com', 'gql.chaingraph.pat.mn'],
      },
    ],

    // ✅ Patient-0 app (v1: declarative + config.screen mapping)
    apps: [
      {
        id: 'authguard',
        name: 'AuthGuard',
        description: 'Token-gated access control v1',
        iconUri: null, // ✅ fall back to DEFAULT_ICON in AppsView
        kind: 'declarative',
        requiredCapabilities: ['utxo:wallet:read', 'tx:build', 'tx:broadcast'],
        config: {
          screen: 'AuthGuardApp',
        },
      },
      {
        id: 'mintCashTokensPoCApp',
        name: 'Mint Tokens',
        description: 'Create fungible or non-fungible tokens',
        iconUri: null, // ✅ fall back to DEFAULT_ICON in AppsView
        kind: 'declarative',
        requiredCapabilities: [
          'wallet:context:read',
          'wallet:addresses:read',
          'utxo:wallet:read',
          'chain:query',
          'tx:add_output',
          'tx:build',
          'tx:broadcast',
        ],
        config: {
          screen: 'MintCashTokensPoCApp',
        },
      },
      {
        id: 'cauldronSwapApp',
        name: 'Cauldron',
        description: 'Swap against Cauldron pools and manage owned liquidity positions',
        iconUri: '/assets/images/cauldron-header-logo.png',
        kind: 'declarative',
        requiredCapabilities: [
          'wallet:context:read',
          'wallet:addresses:read',
          'utxo:wallet:read',
          'chain:query',
          'tx:add_output',
          'tx:build',
          'tx:broadcast',
        ],
        config: {
          screen: 'CauldronSwapApp',
        },
      },
    ],
    contracts: [],

    iconUri: null,
  },
  {
    id: 'optn.builtin.events',
    name: 'Airdrops',
    version: '0.0.1',
    description:
      'Builtin BCH and CashToken airdrop workspace for batch distribution.',
    trustTier: 'internal',
    permissions: [
      {
        kind: 'capabilities',
        capabilities: [
          'wallet:context:read',
          'wallet:addresses:read',
          'utxo:wallet:read',
          'bcmr:token:read',
          'tokenindex:holders:read',
          'http:fetch_json',
          'ui:confirm',
          'signing:message_sign',
        ],
      },
      {
        kind: 'http',
        domains: ['events.optnlabs.com', 'tokenindex.optnlabs.com'],
      },
    ],
    apps: [
      {
        id: 'eventRewardsApp',
        name: 'Airdrops',
        description: 'Batch distribute BCH and CashTokens',
        iconUri: null,
        kind: 'declarative',
        requiredCapabilities: [
          'wallet:context:read',
          'wallet:addresses:read',
          'utxo:wallet:read',
          'bcmr:token:read',
          'tokenindex:holders:read',
          'http:fetch_json',
          'ui:confirm',
          'signing:message_sign',
        ],
        config: {
          screen: 'AirdropsApp',
          apiBaseUrl: 'https://events.optnlabs.com',
        },
      },
    ],
    contracts: [],
    iconUri: null,
  },
  {
    id: 'optn.builtin.fundme',
    name: 'FundMe',
    version: '0.0.1',
    description: 'Demo showcase for BCH crowdfunding flows in OPTN Wallet.',
    trustTier: 'internal',
    permissions: [
      {
        kind: 'capabilities',
        capabilities: [
          'wallet:context:read',
          'wallet:addresses:read',
          'chain:query',
          'signing:signature_template',
          'tx:broadcast',
          'http:fetch_json',
        ],
      },
      {
        kind: 'http',
        domains: ['fundme.cash'],
      },
    ],
    apps: [
      {
        id: 'fundmeApp',
        name: 'FundMe',
        description: 'Demo showcase for BCH crowdfunding inside OPTN Wallet',
        iconUri: '/assets/images/fundme.png',
        kind: 'declarative',
        requiredCapabilities: [
          'wallet:context:read',
          'wallet:addresses:read',
          'chain:query',
          'signing:signature_template',
          'tx:broadcast',
          'http:fetch_json',
        ],
        config: {
          screen: 'FundMeAddonApp',
        },
      },
    ],
    contracts: [],
    iconUri: '/assets/images/fundme.png',
  },
  // Future built-in addons can be added here. Keep in mind these will be shipped with the app, so they should be high-quality, low-maintenance, and showcase best practices for addon development.
];
