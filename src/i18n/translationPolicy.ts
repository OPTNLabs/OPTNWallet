/**
 * Translation policy for the wallet-owned catalog.
 *
 * This is intentionally key-based. A string that contains a stable protocol
 * term is not automatically stable: the surrounding user-facing copy still
 * needs translation. Dynamic values supplied by a dApp or an add-on are not
 * catalog translations and should be classified at the host boundary.
 */
export const TRANSLATION_STATUSES = [
  'translated',
  'needs-review',
  'stable-term',
  'external-value',
  'internal-only',
] as const;

export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number];

export const TRANSLATION_POLICY = {
  stableTermKeys: [
    'actions.cashTokens',
    'actions.title',
    'actions.quantumroot',
    'actions.walletConnect',
    'actions.wizardConnect',
    'assets.bitcoinCash',
    'assets.cashTokens',
    'assets.tabTokens',
    'assets.chipnet',
    'assets.nfts',
    'assets.quantumroot',
    'assets.tabBch',
    'experimental.rpaBadge',
    'faucet.instructions',
    'faucet.name',
    'fusion.p2pMode',
    'fusion.p2pModeLabel',
    'network.chipnet',
    'network.mainnet',
    'quantumroot.popup.outpoint',
    'quantumroot.popup.quantumLock',
    'receive.quantumLock',
    'receive.message',
    'receive.cashToken',
    'send.nft',
    'send.bytes',
    'send.max',
    'send.token',
    'send.tokenLabel',
    'send.totalBch',
    'send.type',
    'send.nfts',
    'send.outpoint',
    'send.sats',
    'settingsNetwork.chipnet',
    'settingsNetwork.mainnet',
    'settingsNetwork.regtest',
    'settingsNetwork.testnet3',
    'settingsNetwork.testnet4',
    'settingsPanels.cashfusion',
    'settingsPanels.faucet',
    'settingsPanels.walletConnect',
    'settingsPanels.wizardConnect',
    'settingsRows.walletConnect',
    'settingsRows.console',
    'settingsRows.faucet',
    'settingsRows.wizardConnect',
    'token.bcmr',
    'terms.modifications',
    'tor.title',
    'rpa.title',
    'txDetails.bch',
    'txDetails.txid',
    'txSummary.bch',
    'txSummary.sats',
    'utxo.bitcoinCash',
    'utxo.ft',
    'utxo.nft',
    'watchOnly.chipnet',
    'watchOnly.mainnet',
    'wizard.dapp',
    'wizard.txid',
    'outbox.txid',
    'wc.txid',
    'contract.transfer',
    'contract.escrow',
    'contract.escrowMS2',
    'contract.msvault',
    'contract.p2pkh',
    'console.placeholder',
    'console.rpc',
    'contractPopup.message',
    'contractView.signature',
    'desktopWallet.walletNumber',
    'history.confirmations',
    'history.status',
    'history.transaction',
    'nav.actions',
    'outbox.destination',
    'settingsAppLock.minute',
    'settingsAppLock.minutes',
    'settingsPanels.console',
    'settingsPanels.server',
    'server.backend',
    'server.manual',
    'server.node',
    'utxo.tokens',
    'wc.index',
    'wizard.index',
    'wizard.status',
    'watchOnly.standard',
    'bip37.blocks',
    'bip37.node',
    'chat.messagePlaceholder',
    'confirm.ok',
    'fusion.servers',
    'nostr.relays',
    'txDetails.index',
    'txDetails.version',
    'txSummary.bytes',
    'txSummary.token',
    'apps.token',
    'apps.wallet',
    'onboarding.welcomeAlt',
  ],
  // Reserved prefixes make the boundary explicit for future catalog entries.
  // Add-on manifest values and iframe content normally never enter this
  // catalog; if they do, they must opt into one of these prefixes.
  externalKeyPrefixes: ['addon.external.', 'apps.external.'],
  internalKeyPrefixes: ['internal.', 'test.'],
} as const;

const stableTermKeys = new Set<string>(TRANSLATION_POLICY.stableTermKeys);

const stableTermValues = new Set([
  'BCH',
  'BIP21',
  'BIP37',
  'BIP39',
  'BIP44',
  'Bitcoin Cash',
  'CashFusion',
  'CashToken',
  'CashTokens',
  'CoinJoin',
  'Electrum',
  'FT',
  'NFT',
  'NFTs',
  'NIP-06',
  'NIP-17',
  'Nostr',
  'OP_RETURN',
  'Outpoint',
  'PSBT',
  'Paycode',
  'QR',
  'Quantumroot',
  'RPA',
  'RPA · Quantumroot',
  'RPC',
  'Sats',
  'SeedCash',
  'Tor',
  'UTXO',
  'UTXOs',
  'WalletConnect',
  'WSS',
  'WizardConnect',
  'xPub',
  'Mainnet',
  'Chipnet',
  'Testnet3',
  'Testnet4',
  'Regtest',
  'TransferWithTimeout',
  'P2P Fusion',
  '…',
]);

function hasPrefix(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

export function isStableTermKey(key: string): boolean {
  return stableTermKeys.has(key);
}

export function isExternalTranslationKey(key: string): boolean {
  return hasPrefix(key, TRANSLATION_POLICY.externalKeyPrefixes);
}

export function isInternalTranslationKey(key: string): boolean {
  return hasPrefix(key, TRANSLATION_POLICY.internalKeyPrefixes);
}

export function isStableTermValue(value: string): boolean {
  return stableTermValues.has(value.trim());
}

export function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)]
    .map((match) => match[1])
    .sort();
}

export function classifyTranslation(
  key: string,
  englishValue: string,
  localizedValue: string,
  locale = 'en'
): TranslationStatus {
  if (isInternalTranslationKey(key)) return 'internal-only';
  if (isExternalTranslationKey(key)) return 'external-value';
  if (
    isStableTermKey(key) ||
    (locale !== 'en' && isStableTermValue(englishValue))
  ) {
    return 'stable-term';
  }
  if (locale === 'en' || localizedValue !== englishValue) {
    return 'translated';
  }
  return 'needs-review';
}

export function placeholderMismatch(
  englishValue: string,
  localizedValue: string
): boolean {
  return (
    placeholders(englishValue).join('\u0000') !==
    placeholders(localizedValue).join('\u0000')
  );
}
