// src/addons/builtin/index.ts
import type { AddonManifest } from '../../types/addons';

// Reuse an existing CashScript artifact as the addon-provided contract.
// This keeps v1 simple: prove addon plumbing works end-to-end.
import p2pkhArtifact from '../../apis/ContractManager/artifacts/p2pkh.json';

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
        name: 'Mint Cashtokens',
        description: 'V1',
        iconUri: null, // ✅ fall back to DEFAULT_ICON in AppsView
        kind: 'declarative',
        requiredCapabilities: [
          'wallet:context:read',
          'wallet:addresses:read',
          'utxo:wallet:read',
          'tx:add_output',
          'tx:build',
          'tx:broadcast',
        ],
        config: {
          screen: 'MintCashTokensPoCApp',
        },
      },
    ],

    contracts: [
      {
        id: 'p2pkh-demo',
        name: 'Addon: P2PKH Demo',
        description:
          'Same artifact as builtin p2pkh, served through addon registry.',
        cashscriptArtifact: p2pkhArtifact as unknown,
        functions: [],
      },
    ],

    iconUri: null,
  },
  {
    id: 'optn.builtin.events',
    name: 'Airdrops',
    version: '0.0.1',
    description: 'Builtin BCH and CashToken airdrop workspace for batch distribution.',
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
        description: 'Batch distribute BCH and CashTokens from OPTN Wallet.',
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
    contracts: [
      {
        id: 'p2pkh-event-demo',
        name: 'Addon: Airdrops P2PKH Demo',
        description: 'Placeholder contract entry for the Airdrops addon manifest.',
        cashscriptArtifact: p2pkhArtifact as unknown,
        functions: [],
      },
    ],
    iconUri: null,
  },
];
