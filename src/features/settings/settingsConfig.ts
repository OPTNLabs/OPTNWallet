import { ROUTE_PATHS } from '../../navigation/routes';

export type SettingsPanelKey =
  | 'recovery'
  | 'about'
  | 'terms'
  | 'contact'
  | 'contract'
  | 'walletconnect'
  | 'wizardconnect'
  | 'network';

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
    description: 'Coming soon',
    action: 'noop',
    right: '(Coming soon)',
  },
];

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
