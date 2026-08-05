import { ROUTE_PATHS } from '../../navigation/routes';
import { Network } from '../../state/slices/networkSlice';

export type SettingsPanelKey =
  | 'recovery'
  | 'about'
  | 'terms'
  | 'contact'
  | 'contract'
  | 'walletconnect'
  | 'wizardconnect'
  | 'network'
  | 'faucet'
  | 'derivation'
  | 'server'
  | 'console'
  | 'experimental'
  | 'cashfusion'
  | 'nostr'
  | 'addons'
  | 'app-lock'
  | 'rebuild-wallet'
  | 'export-archive';

export type SettingsGroupKey =
  | 'wallet'
  | 'features'
  | 'about';

export type SettingsRowConfig = {
  key: SettingsPanelKey | string;
  title: string;
  description?: string;
  action?: 'panel' | 'navigate' | 'noop';
  target?: string;
  right?: string;
};

export const WALLET_ROWS: SettingsRowConfig[] = [
  {
    key: 'network',
    title: 'Network',
    description: 'Switch between Mainnet and Chipnet',
    action: 'panel',
    target: 'network',
  },
  {
    key: 'faucet',
    title: 'Chipnet Faucet',
    description: 'Get test BCH on Chipnet',
    action: 'panel',
    target: 'faucet',
  },
  {
    key: 'derivation',
    title: 'Derivation Path',
    description: 'Customize and resync the active BIP44 path',
    action: 'panel',
    target: 'derivation',
  },
  {
    key: 'recovery',
    title: 'Recovery Phrase',
    description: 'Back up your wallet',
    action: 'panel',
    target: 'recovery',
  },
  {
    key: 'pending-outbox',
    title: 'Pending Tx Locks',
    description: 'Review outgoing transaction locks',
    action: 'navigate',
    target: ROUTE_PATHS.outbox,
  },
  {
    key: 'app-lock',
    title: 'App Lock',
    description: 'Auto-lock · Change password',
    action: 'panel',
    target: 'app-lock',
  },
  {
    key: 'export-archive',
    title: 'Wallet pack export',
    description: 'Export/import .optn + .optn-cold (keys + encrypted data)',
    action: 'panel',
    target: 'export-archive',
  },
  {
    key: 'rebuild-wallet',
    title: 'Rebuild Wallet',
    description: 'Wipe chain data and resync from network (keeps seed)',
    action: 'panel',
    target: 'rebuild-wallet',
  },
  {
    key: 'nostr',
    title: 'Nostr & Chat',
    description: 'Private messages · Identity · Relay pool',
    action: 'panel',
    target: 'nostr',
  },
  {
    key: 'server',
    title: 'Servers',
    description: 'Electrum · Block explorer · Transaction fees',
    action: 'panel',
    target: 'server',
  },
  {
    key: 'console',
    title: 'Console',
    description: 'App log · Electrum RPC',
    action: 'panel',
    target: 'console',
  },
  {
    key: 'experimental',
    title: 'Experimental Features',
    description: 'RPA · CashFusion',
    action: 'panel',
    target: 'experimental',
  },
  {
    key: 'addons',
    title: 'Addons',
    description: 'Install and manage third-party addons',
    action: 'panel',
    target: 'addons',
  },
  // CashFusion + Tor now live inside the Servers panel (that panel manages
  // everything network-related), so there is no separate CashFusion row.
];

export const SETTINGS_GROUPS: Array<{
  key: SettingsGroupKey;
  title: string;
  description: string;
}> = [
  {
    key: 'wallet',
    title: 'Wallet & security',
    description: 'Recovery, derivation path, app lock, rebuild, and wallet controls',
  },
  {
    key: 'features',
    title: 'Connections & features',
    description: 'Servers, integrations, privacy features, and advanced tools',
  },
  {
    key: 'about',
    title: 'About & support',
    description: 'Help, contact, terms, and app information',
  },
];

export function getVisibleWalletRows(
  _isDesktop: boolean,
  currentNetwork: Network
): SettingsRowConfig[] {
  const networkRows = WALLET_ROWS.filter(
    (row) => row.key !== 'faucet' || currentNetwork === Network.CHIPNET
  );
  const commonKeys = new Set(['network', 'faucet', 'pending-outbox']);
  return networkRows.filter((row) => commonKeys.has(String(row.key)));
}

export function getSettingsGroupRows(
  group: SettingsGroupKey,
  isDesktop: boolean,
  currentNetwork: Network
): SettingsRowConfig[] {
  const rowsByGroup: Record<SettingsGroupKey, SettingsRowConfig[]> = {
    wallet: WALLET_ROWS.filter((row) =>
      [
        'recovery',
        'derivation',
        'app-lock',
        'export-archive',
        'rebuild-wallet',
      ].includes(String(row.key))
    ),
    features: [
      WALLET_ROWS.find((row) => row.key === 'server')!,
      WALLET_ROWS.find((row) => row.key === 'nostr')!,
      ...CONNECTION_ROWS,
      WALLET_ROWS.find((row) => row.key === 'experimental')!,
      ...WALLET_ROWS.filter((row) =>
        ['console', 'addons'].includes(String(row.key))
      ),
    ],
    // Contract details live inside the About panel (not a separate row).
    about: ABOUT_ROWS,
  };

  return rowsByGroup[group].filter((row) => {
    if (row.key === 'faucet' && currentNetwork !== Network.CHIPNET) return false;
    if (
      !isDesktop &&
      [
        'app-lock',
        'rebuild-wallet',
        'export-archive',
        'console',
        'addons',
      ].includes(String(row.key))
    ) {
      return false;
    }
    return true;
  });
}

/** @deprecated Contract info is embedded in About — kept for deep-link compat. */
export const CONTRACT_ROWS: SettingsRowConfig[] = [];

export const CONNECTION_ROWS: SettingsRowConfig[] = [
  {
    key: 'walletconnect',
    title: 'WalletConnect',
    description: 'Manage dApp connections',
    action: 'panel',
    target: 'walletconnect',
  },
  {
    key: 'wizardconnect',
    title: 'WizardConnect',
    description: 'Connect to token wizards',
    action: 'panel',
    target: 'wizardconnect',
  },
];

export const ABOUT_ROWS: SettingsRowConfig[] = [
  {
    key: 'about',
    title: 'About OPTN',
    description: 'App overview · Bitcoin Cash Contracts info',
    action: 'panel',
    target: 'about',
  },
  {
    key: 'terms',
    title: 'Terms of Use',
    description: 'Read our terms',
    action: 'panel',
    target: 'terms',
  },
  {
    key: 'contact',
    title: 'Contact Us',
    description: 'Get help and support',
    action: 'panel',
    target: 'contact',
  },
];
