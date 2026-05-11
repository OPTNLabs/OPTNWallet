export type ActionConfig = {
  title: string;
  description?: string;
  to: string;
};

export const BASIC_ACTIONS: ActionConfig[] = [
  {
    title: 'Send',
    description: 'Send BCH or Cashtokens',
    to: '/send',
  },
  {
    title: 'Receive',
    description: 'Receive BCH or Cashtokens',
    to: '/receive',
  },
  {
    title: 'Scan QR',
    description: 'Sweep Paper wallets',
    to: '/paper-wallet-sweep',
  },
  {
    title: 'New Address',
    description: 'Generate new address',
    to: '/receive?panel=addresses',
  },
  {
    title: 'Mint Tokens',
    description: 'Create new CashTokens',
    to: '/mint-cashtokens-poc',
  },
];

export const ADVANCED_ACTIONS: ActionConfig[] = [
  {
    title: 'Quantumroot',
    description: 'Quantum-ready vaults',
    to: '/quantumroot',
  },
  {
    title: 'Transaction Builder',
    description: 'Build custom transactions',
    to: '/transaction',
  },
  {
    title: 'WalletConnect',
    description: 'Manage dApp sessions',
    to: '/settings?panel=walletconnect',
  },
  {
    title: 'WizardConnect',
    description: 'XPub key enabled dApp sessions',
    to: '/settings?panel=wizardconnect',
  },
  {
    title: 'Contracts',
    description: 'Manage contract instances',
    to: '/contract',
  },
];
