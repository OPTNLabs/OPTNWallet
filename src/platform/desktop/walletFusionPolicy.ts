// Per-wallet Fusion policy — Electron Cash's wallet-vs-process settings split.
//
// EC keeps "how THIS wallet fuses" in the wallet file (`cashfusion_autofuse`,
// `cashfusion_fuse_depth`, `cashfusion_fusion_mode`) and only process-level
// transport config (`cashfusion_server`, `cashfusion_tor_host`) in the global
// config. Ours lived entirely in the `experimental` redux slice, which
// redux-persist writes into the PER-WINDOW localForage partition — and
// `openWalletPickerWindow` mints a fresh `wallet-<timestamp>` partition on every
// open. So a wallet's fusion settings did not follow it between windows, and for
// any window but the first they were effectively discarded on close.
//
// Keyed by wallet id in localStorage: shared by every window, survives restarts,
// and independent of which window happens to be showing the wallet.

import { getLocalStorage } from '../../utils/browserStorage';
import { clampFuseDepth, DEFAULT_FUSE_DEPTH } from '../../state/slices/experimentalSlice';

const POLICY_KEY = 'optn-wallet-fusion-policy';

export interface WalletFusionPolicy {
  cashFusionEnabled: boolean;
  autoFuseEnabled: boolean;
  p2pFusionEnabled: boolean;
  fuseDepth: number;
  spendOnlyFusedCoins: boolean;
}

/** Matches the redux defaults, so a wallet with no stored policy behaves as before. */
export const DEFAULT_WALLET_FUSION_POLICY: WalletFusionPolicy = {
  cashFusionEnabled: false,
  autoFuseEnabled: true,
  p2pFusionEnabled: true,
  fuseDepth: DEFAULT_FUSE_DEPTH,
  spendOnlyFusedCoins: false,
};

type PolicyMap = Record<string, Partial<WalletFusionPolicy>>;

function readAll(): PolicyMap {
  try {
    const raw = getLocalStorage()?.getItem(POLICY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as PolicyMap;
  } catch {
    return {};
  }
}

function writeAll(map: PolicyMap): void {
  try {
    getLocalStorage()?.setItem(POLICY_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable — policy falls back to defaults */
  }
}

/**
 * Stored policy for a wallet, with defaults filled in.
 *
 * Each field is validated independently rather than trusting the stored object:
 * a partially written or hand-edited record must not put the engine into a state
 * the UI cannot express — `fuseDepth` in particular is clamped, since 0 would
 * mean "never stop fusing".
 */
export function readWalletFusionPolicy(walletId: number): WalletFusionPolicy {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) {
    return { ...DEFAULT_WALLET_FUSION_POLICY };
  }
  const stored = readAll()[String(walletId)] ?? {};
  return {
    cashFusionEnabled:
      typeof stored.cashFusionEnabled === 'boolean'
        ? stored.cashFusionEnabled
        : DEFAULT_WALLET_FUSION_POLICY.cashFusionEnabled,
    autoFuseEnabled:
      typeof stored.autoFuseEnabled === 'boolean'
        ? stored.autoFuseEnabled
        : DEFAULT_WALLET_FUSION_POLICY.autoFuseEnabled,
    p2pFusionEnabled:
      typeof stored.p2pFusionEnabled === 'boolean'
        ? stored.p2pFusionEnabled
        : DEFAULT_WALLET_FUSION_POLICY.p2pFusionEnabled,
    fuseDepth: clampFuseDepth(
      stored.fuseDepth ?? DEFAULT_WALLET_FUSION_POLICY.fuseDepth
    ),
    spendOnlyFusedCoins:
      typeof stored.spendOnlyFusedCoins === 'boolean'
        ? stored.spendOnlyFusedCoins
        : DEFAULT_WALLET_FUSION_POLICY.spendOnlyFusedCoins,
  };
}

/** Persist this wallet's policy. Other wallets' entries are left untouched. */
export function writeWalletFusionPolicy(
  walletId: number,
  policy: WalletFusionPolicy
): void {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return;
  const all = readAll();
  all[String(walletId)] = {
    ...policy,
    fuseDepth: clampFuseDepth(policy.fuseDepth),
  };
  writeAll(all);
}

/** Forget a deleted wallet's policy so its id cannot be reused with stale settings. */
export function clearWalletFusionPolicy(walletId: number): void {
  const all = readAll();
  if (delete all[String(walletId)]) writeAll(all);
}
