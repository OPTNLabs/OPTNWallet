export const ROUTE_PATHS = {
  root: '/',
  landing: '/landing',
  createWallet: '/createwallet',
  importWallet: '/importwallet',
  home: '/home/:wallet_id',
  assets: '/assets',
  actions: '/actions',
  contract: '/contract',
  apps: '/apps',
  paryon: '/paryon',
  appDetail: '/apps/:appId',
  fundmeLegacy: '/apps/fundme',
  campaignDetail: '/campaign/:id',
  receive: '/receive',
  quantumroot: '/quantumroot',
  send: '/send',
  outbox: '/outbox',
  transactionBuilder: '/transaction',
  transactions: '/transactions/:wallet_id',
  historyLegacy: '/history/:wallet_id',
  settings: '/settings',
} as const;

export const ROUTE_ALIAS_MAP = [
  {
    path: ROUTE_PATHS.root,
    kind: 'entrypoint',
    target: 'Wallet availability gate',
  },
  {
    path: ROUTE_PATHS.historyLegacy,
    kind: 'redirect',
    target: ROUTE_PATHS.transactions,
  },
  {
    path: ROUTE_PATHS.fundmeLegacy,
    kind: 'redirect',
    target: '/apps/optn.builtin.fundme:fundmeApp',
  },
] as const;

export function homeRoute(walletId: string | number | null | undefined) {
  return `/home/${walletId ?? ''}`;
}

export function transactionsRoute(walletId: string | number | null | undefined) {
  return `/transactions/${walletId ?? ''}`;
}
