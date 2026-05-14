export function isComingSoonApp(appId: string, appName: string): boolean {
  const normalizedId = appId.toLowerCase();
  const normalizedName = appName.toLowerCase();
  return (
    normalizedId.endsWith(':authguard') ||
    normalizedName === 'authguard' ||
    normalizedId.endsWith(':fundmeapp') ||
    normalizedName === 'fundme' ||
    normalizedId.endsWith(':paryonworkspaceapp') ||
    normalizedName.includes('paryonusd')
  );
}

export type AppsViewCategory =
  | 'Wallet'
  | 'Token'
  | 'Utils'
  | 'Advanced';

const APP_CATEGORY_ORDER: Record<AppsViewCategory, number> = {
  Wallet: 0,
  Token: 1,
  Utils: 2,
  Advanced: 3,
};

export function normalizeAppKey(value: string): string {
  return value.trim().toLowerCase();
}

export function getAppCategory(app: { id: string; name: string }): AppsViewCategory {
  const normalizedId = normalizeAppKey(app.id);
  const normalizedName = normalizeAppKey(app.name);
  if (normalizedId.endsWith(':contractview') || normalizedName === 'contracts') {
    return 'Wallet';
  }
  if (
    normalizedId.endsWith(':paperwalletsweepapp') ||
    normalizedName === 'paper wallet' ||
    normalizedName.includes('walletconnect')
  ) {
    return 'Wallet';
  }
  if (
    normalizedId.endsWith(':mintcashtokenspocapp') ||
    normalizedName === 'mint tokens' ||
    normalizedName.includes('paryonusd')
  ) {
    return 'Token';
  }
  if (normalizedName.includes('airdrop') || normalizedName.includes('airdrops')) {
    return 'Utils';
  }
  if (
    normalizedId.endsWith(':cauldronswapapp') ||
    normalizedName === 'cauldron' ||
    normalizedName.includes('fundme')
  ) {
    return 'Advanced';
  }
  return 'Utils';
}

export function getAppSortPriority(app: { id: string; name: string }): number {
  const normalizedId = normalizeAppKey(app.id);
  const normalizedName = normalizeAppKey(app.name);
  if (normalizedId.endsWith(':contracts') || normalizedName === 'contracts') return 0;
  if (normalizedId.endsWith(':paperwalletsweepapp') || normalizedName === 'paper wallet') return 1;
  if (normalizedId.endsWith(':mintcashtokenspocapp') || normalizedName === 'mint tokens') return 0;
  if (normalizedName.includes('paryonusd')) return 1;
  if (normalizedId.endsWith(':eventrewardsapp') || normalizedName === 'airdrops') return 0;
  if (normalizedId.endsWith(':fundmeapp') || normalizedName === 'fundme') return 0;
  if (normalizedId.endsWith(':cauldronswapapp') || normalizedName === 'cauldron') return 1;
  return 10;
}

export function getAppCategoryPriority(category: AppsViewCategory): number {
  return APP_CATEGORY_ORDER[category] ?? 99;
}

function compareAsciiCaseInsensitive(left: string, right: string): number {
  const a = normalizeAppKey(left);
  const b = normalizeAppKey(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function compareAppsForBrowse(
  left: {
    comingSoon?: boolean;
    disabled?: boolean;
    name: string;
  },
  right: {
    comingSoon?: boolean;
    disabled?: boolean;
    name: string;
  }
): number {
  if (left.comingSoon !== right.comingSoon) {
    return left.comingSoon ? 1 : -1;
  }
  if (left.disabled !== right.disabled) {
    return left.disabled ? 1 : -1;
  }
  return compareAsciiCaseInsensitive(left.name, right.name);
}

export function getAppDescription(app: {
  id: string;
  name: string;
  description: string;
}): string {
  const normalizedId = normalizeAppKey(app.id);
  const normalizedName = normalizeAppKey(app.name);
  if (normalizedId.endsWith(':cauldronswapapp') || normalizedName === 'cauldron') {
    return 'Swap BCH and CashTokens';
  }
  return app.description;
}

export function getAppIconFrame(app: { name: string }): string {
  const normalized = normalizeAppKey(app.name);
  if (normalized.includes('walletconnect')) return 'bg-sky-500/15 text-sky-300';
  if (normalized.includes('paper wallet')) return 'bg-amber-500/15 text-amber-300';
  if (normalized.includes('cauldron')) return 'bg-violet-500/15 text-violet-300';
  if (normalized.includes('mint')) return 'bg-emerald-500/15 text-emerald-300';
  if (normalized.includes('fundme')) return 'bg-rose-500/15 text-rose-300';
  return 'bg-[color-mix(in_oklab,var(--wallet-accent-soft)_70%,transparent)] text-[var(--wallet-accent-strong)]';
}

export function shouldHideApp(appId: string, appName: string): boolean {
  const normalizedId = appId.toLowerCase();
  const normalizedName = appName.toLowerCase();
  return normalizedId.endsWith(':authguard') || normalizedName === 'authguard';
}
