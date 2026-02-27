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
    permissions: [{ kind: 'none' }],

    // ✅ Patient-0 app (v1: declarative + config.screen mapping)
    apps: [
      {
        id: 'authguard',
        name: 'AuthGuard',
        description: 'Patient-0 marketplace app (SDK + routing smoke test).',
        iconUri: null, // ✅ fall back to DEFAULT_ICON in AppsView
        kind: 'declarative',
        config: {
          screen: 'AuthGuardApp',
        },
      },
      {
        id: 'mintCashTokensPoCApp',
        name: 'MintCashTokensPoCApp',
        description: 'Mint Cashtokens',
        iconUri: null, // ✅ fall back to DEFAULT_ICON in AppsView
        kind: 'declarative',
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
];
