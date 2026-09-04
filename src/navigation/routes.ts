export const ROUTE_PATHS = {
  root: '/',
  landing: '/landing',
  createWallet: '/createwallet',
  importWallet: '/importwallet',
  multisigSetup: '/multisig/setup',
  multisigWorkspace: '/multisig/:wallet_id/*',
  home: '/home/:wallet_id',
  assets: '/assets',
  actions: '/actions',
  chat: '/chat',
  chatConversation: '/chat/:conversationId',
  contract: '/contract',
  apps: '/apps',
  paryon: '/paryon',
  appDetail: '/apps/:appId',
  fundmeLegacy: '/apps/fundme',
  campaignDetail: '/campaign/:id',
  receive: '/receive',
  quantumroot: '/quantumroot',
  cashfusion: '/cashfusion',
  send: '/send',
  outbox: '/outbox',
  transactionBuilder: '/transaction',
  qrSigningDemo: '/qr-signing-demo',
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

export type MultisigRouteSection =
  | 'home'
  | 'receive'
  | 'send'
  | 'sign'
  | 'policy';

/** Routes for the multisig workspace are intentionally separate from the regular wallet UI. */
export function multisigRoute(
  walletId: string | number | null | undefined,
  section: MultisigRouteSection = 'home'
) {
  const base = `/multisig/${walletId ?? ''}`;
  return section === 'home' ? base : `${base}/${section}`;
}

export function transactionsRoute(
  walletId: string | number | null | undefined
) {
  return `/transactions/${walletId ?? ''}`;
}
