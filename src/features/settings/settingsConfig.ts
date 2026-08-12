import { ROUTE_PATHS } from '../../navigation/routes';

export type SettingsPanelKey =
  | 'recovery'
  | 'about'
  | 'terms'
  | 'contact'
  | 'contract'
  | 'walletconnect'
  | 'wizardconnect'
  | 'network'
  | 'server'
  | 'console'
  | 'experimental'
  | 'cashfusion'
  | 'nostr'
  | 'addons';

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
    key: 'nostr',
    title: 'Nostr & Chat',
    description: 'Private messages · Identity · Relay pool',
    action: 'panel',
    target: 'nostr',
  },
  {
    key: 'server',
    title: 'Servers',
    description: 'Electrum · Block explorer · CashFusion · Tor',
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

const MOBILE_HIDDEN_WALLET_SETTING_KEYS = new Set([
  'network',
  'nostr',
  'server',
  'console',
  'experimental',
  'addons',
]);

export function getVisibleWalletRows(isDesktop: boolean): SettingsRowConfig[] {
  if (isDesktop) return WALLET_ROWS;

  return WALLET_ROWS.filter(
    (row) => !MOBILE_HIDDEN_WALLET_SETTING_KEYS.has(row.key)
  );
}

export const CONTRACT_ROWS: SettingsRowConfig[] = [
  {
    key: 'contract-info',
    title: 'Contract Info',
    description: 'View contract details',
    action: 'panel',
    target: 'contract',
  },
];

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
    description: 'Version info',
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
