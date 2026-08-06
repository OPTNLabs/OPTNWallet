import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { createSelector } from 'reselect';
import type { RootState } from '../store';
import {
  DEFAULT_RELAYS,
  isDefaultNostrRelay,
  mergeWithDefaultRelays,
} from '../../platform/desktop/nostr/defaultRelays';

// Electron Cash ships exactly one default mainnet fusion server (conf.py
// _get_default_server_list) — fusion.servo.cash:8789. That is the live public
// coordinator; treat it as the production target for mainnet Auto/manual.
//
// DEACTIVATED / dead hosts (do not re-introduce as defaults):
//   • cashfusion.electroncash.dk — no longer resolves (migrated away at read)
//   • chipnet.bch.ninja:8789 — historically offered; often down / not the
//     chipnet test path we use today
//
// Network defaults (string keys match Network enum: 'mainnet' | 'chipnet'):
//   mainnet → fusion.servo.cash:8789  (strict EC public server + Tor required)
//   chipnet → 127.0.0.1:8787         (local EC server.py for wire tests only)
//
// MAINNET IN MIND:
//   • Never point mainnet Auto at the chipnet loopback harness.
//   • Never ship client-side "min_clients=2" / weakened server Params on mainnet
//     — those exist only in run_fusion_server.py for local multi-window tests.
//   • Remote mainnet fusion traffic stays Tor-only (EC rule; localhost exempt).
//   • Protocol timing/constants stay strict EC regardless of network.
//
// Chipnet local server:  python run_fusion_server.py 8787 chipnet
const DEFAULT_FUSION_SERVER = 'fusion.servo.cash:8789';

const DEFAULT_FUSION_SERVERS: Record<string, string> = {
  mainnet: DEFAULT_FUSION_SERVER,
  chipnet: '127.0.0.1:8787',
};

/** Chipnet UI alternatives (local first; public chipnet host may be down). */
export const KNOWN_CHIPNET_FUSION_SERVERS = [
  '127.0.0.1:8787',
  'chipnet.bch.ninja:8789',
];
const KNOWN_DEFAULT_FUSION_SERVERS = new Set(
  Object.values(DEFAULT_FUSION_SERVERS)
);

// Built-in bootstrap relays (not user-removable). Shared with chat/fusion.
const DEFAULT_NOSTR_RELAYS = [...DEFAULT_RELAYS];

/** Rounds a coin is fused before the engine stops picking it up. */
export const DEFAULT_FUSE_DEPTH = 3;
/** 1..10 — a bound, not a preference: each round costs a real fee. */
export const MIN_FUSE_DEPTH = 1;
export const MAX_FUSE_DEPTH = 10;

export function clampFuseDepth(value: unknown): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_FUSE_DEPTH;
  return Math.min(MAX_FUSE_DEPTH, Math.max(MIN_FUSE_DEPTH, n));
}

interface ExperimentalState {
  rpaEnabled: boolean;
  cashFusionEnabled: boolean;
  nostrChatEnabled: boolean;
  // One-time migration marker: legacy persisted state stored the old default
  // as `false`. Once migrated to the new default-on behavior, an explicit user
  // opt-out must remain respected on later launches.
  nostrChatDefaultOnApplied: boolean;
  nostrRelays: string[];
  // ONE auto-fusion policy shared by both transports. Whichever Fusion mode is
  // selected is the one the engine may run — the modes are mutually exclusive
  // (getFusionModeAvailability), so a single flag cannot start two at once.
  autoFuseEnabled: boolean;
  // Electron Cash's `cashfusion_fuse_depth`: how many times a coin may be fused
  // before the engine leaves it alone. Same meaning as the UI label
  // "Rounds per coin". EC treats 0 as "keep fusing forever"; we default to 3.
  fuseDepth: number;
  /**
   * When true, ordinary sends may only spend coins with fuse depth ≥ 1
   * (already through at least one CashFusion). Fresh receives stay unspendable
   * for normal send until fused — Electron Cash–style privacy spend policy.
   */
  spendOnlyFusedCoins: boolean;
  // Which transport a round uses. Mutually exclusive with Server Fusion.
  p2pFusionEnabled: boolean;
  fusionServer: string;
  fusionServers: string[];
  // Tor is reached as a SOCKS5 proxy the user already runs — same model as
  // Electron Cash (TOR_PORTS = [9050, 9150]). We don't bundle a Tor daemon.
  torEnabled: boolean;
  torAuto: boolean; // auto-detect the SOCKS port
  torHost: string;
  torPortManual: number;
  quantumrootEnabled: boolean;
}

const initialState: ExperimentalState = {
  rpaEnabled: false,
  cashFusionEnabled: false,
  nostrChatEnabled: true,
  nostrChatDefaultOnApplied: true,
  nostrRelays: DEFAULT_NOSTR_RELAYS,
  autoFuseEnabled: true,
  fuseDepth: DEFAULT_FUSE_DEPTH,
  spendOnlyFusedCoins: false,
  p2pFusionEnabled: true,
  fusionServer: DEFAULT_FUSION_SERVER,
  fusionServers: [DEFAULT_FUSION_SERVER],
  // On by default: CashFusion against a remote server without Tor lets the
  // server correlate a player's coins by IP, defeating the whole point. Users
  // can turn it off, but the remote-fusion path enforces it regardless.
  torEnabled: true,
  torAuto: true,
  torHost: '127.0.0.1',
  torPortManual: 9050,
  // Quantumroot ships enabled by default; the toggle lets users hide it.
  quantumrootEnabled: true,
};

/**
 * redux-persist restores old slice objects wholesale. Add fields introduced
 * after an older wallet was saved without changing any explicit user choice.
 */
export function normalizeExperimentalPersistedState(
  state: unknown
): Record<string, unknown> | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state))
    return undefined;

  const persisted = state as Record<string, unknown>;
  const defaultOnAlreadyApplied = persisted.nostrChatDefaultOnApplied === true;

  return {
    autoFuseEnabled: true,
    p2pFusionEnabled: true,
    ...persisted,
    // Spread first, then clamp: a wallet persisted before this field existed
    // gets the default, and a persisted out-of-range value is pulled back into
    // bounds rather than letting the engine loop on a 0 or negative depth.
    fuseDepth: clampFuseDepth(
      persisted.fuseDepth ?? DEFAULT_FUSE_DEPTH
    ),
    // Default false unless user explicitly opted in (must follow ...persisted).
    spendOnlyFusedCoins: persisted.spendOnlyFusedCoins === true,
    nostrChatEnabled: defaultOnAlreadyApplied
      ? persisted.nostrChatEnabled !== false
      : true,
    nostrChatDefaultOnApplied: true,
    // Ensure expanded bootstrap relays appear for older persisted 3-relay lists.
    nostrRelays: mergeWithDefaultRelays(
      Array.isArray(persisted.nostrRelays)
        ? (persisted.nostrRelays as string[])
        : undefined
    ),
  };
}

function normalizeServer(raw: string): string {
  return raw.trim();
}

const experimentalSlice = createSlice({
  name: 'experimental',
  initialState,
  reducers: {
    setRpaEnabled(state, action: PayloadAction<boolean>) {
      state.rpaEnabled = action.payload;
    },
    setCashFusionEnabled(state, action: PayloadAction<boolean>) {
      state.cashFusionEnabled = action.payload;
    },
    setNostrChatEnabled(state, action: PayloadAction<boolean>) {
      state.nostrChatEnabled = action.payload;
    },
    addNostrRelay(state, action: PayloadAction<string>) {
      const relay = action.payload.trim();
      if (!Array.isArray(state.nostrRelays))
        state.nostrRelays = [...DEFAULT_NOSTR_RELAYS];
      if (relay && !state.nostrRelays.includes(relay))
        state.nostrRelays.push(relay);
    },
    removeNostrRelay(state, action: PayloadAction<string>) {
      if (!Array.isArray(state.nostrRelays))
        state.nostrRelays = [...DEFAULT_NOSTR_RELAYS];
      const target = action.payload.trim();
      // Same rule as Fulcrum seed servers: bootstrap list is not removable.
      if (isDefaultNostrRelay(target)) return;
      const key = target.toLowerCase().replace(/\/+$/, '');
      state.nostrRelays = state.nostrRelays.filter(
        (r) => r.trim().toLowerCase().replace(/\/+$/, '') !== key
      );
      // Never empty the pool — always keep at least the built-in set.
      if (state.nostrRelays.length === 0) {
        state.nostrRelays = [...DEFAULT_NOSTR_RELAYS];
      }
    },
    setAutoFuseEnabled(state, action: PayloadAction<boolean>) {
      state.autoFuseEnabled = action.payload;
    },
    setP2pFusionEnabled(state, action: PayloadAction<boolean>) {
      state.p2pFusionEnabled = action.payload;
    },
    setFuseDepth(state, action: PayloadAction<number>) {
      // Clamp in the reducer, not the input handler: both Fusion cards write
      // this same value, and the engine reads it in a loop — an unclamped 0
      // would mean "never stop fusing".
      state.fuseDepth = clampFuseDepth(action.payload);
    },
    setSpendOnlyFusedCoins(state, action: PayloadAction<boolean>) {
      state.spendOnlyFusedCoins = action.payload;
    },
    setFusionServer(state, action: PayloadAction<string>) {
      state.fusionServer = normalizeServer(action.payload);
    },
    addFusionServer(state, action: PayloadAction<string>) {
      const server = normalizeServer(action.payload);
      // State persisted before fusionServers existed rehydrates without this
      // array; initialise it so a push can't throw on it.
      if (!Array.isArray(state.fusionServers)) {
        state.fusionServers = state.fusionServer
          ? [state.fusionServer]
          : [DEFAULT_FUSION_SERVER];
      }
      if (server && !state.fusionServers.includes(server)) {
        state.fusionServers.push(server);
      }
    },
    removeFusionServer(state, action: PayloadAction<string>) {
      const server = normalizeServer(action.payload);
      if (!Array.isArray(state.fusionServers)) {
        state.fusionServers = state.fusionServer
          ? [state.fusionServer]
          : [DEFAULT_FUSION_SERVER];
      }
      state.fusionServers = state.fusionServers.filter((s) => s !== server);
      // Never leave the selected server pointing at something no longer in the list.
      if (state.fusionServer === server) {
        state.fusionServer = state.fusionServers[0] ?? DEFAULT_FUSION_SERVER;
      }
    },
    /** Replace the whole list — used when adopting the shared transport config
     *  written by another window, where add/remove one-at-a-time would not
     *  converge on the stored set. */
    setFusionServers(state, action: PayloadAction<string[]>) {
      if (action.payload.length > 0) state.fusionServers = action.payload;
    },
    setNostrRelays(state, action: PayloadAction<string[]>) {
      // An empty pool leaves P2P fusion unable to find peers, which presents as
      // "no peers" rather than as a broken setting. Always retain bootstrap.
      if (action.payload.length > 0) {
        state.nostrRelays = mergeWithDefaultRelays(action.payload);
      }
    },
    setTorEnabled(state, action: PayloadAction<boolean>) {
      state.torEnabled = action.payload;
    },
    setTorAuto(state, action: PayloadAction<boolean>) {
      state.torAuto = action.payload;
    },
    setTorHost(state, action: PayloadAction<string>) {
      state.torHost = action.payload.trim() || '127.0.0.1';
    },
    setTorPortManual(state, action: PayloadAction<number>) {
      state.torPortManual = action.payload;
    },
    setQuantumrootEnabled(state, action: PayloadAction<boolean>) {
      state.quantumrootEnabled = action.payload;
    },
  },
});

export const {
  setRpaEnabled,
  setCashFusionEnabled,
  setNostrChatEnabled,
  addNostrRelay,
  removeNostrRelay,
  setAutoFuseEnabled,
  setP2pFusionEnabled,
  setFuseDepth,
  setSpendOnlyFusedCoins,
  setFusionServer,
  addFusionServer,
  removeFusionServer,
  setFusionServers,
  setNostrRelays,
  setTorEnabled,
  setTorAuto,
  setTorHost,
  setTorPortManual,
  setQuantumrootEnabled,
} = experimentalSlice.actions;

// The old default this app shipped points at a host that no longer resolves;
// migrate any persisted reference to it over to the real one at read time.
const DEAD_FUSION_SERVER = 'cashfusion.electroncash.dk';
function migrateDeadServer(server: string): string {
  return server.startsWith(DEAD_FUSION_SERVER) ? DEFAULT_FUSION_SERVER : server;
}

export const selectRpaEnabled = (state: RootState) =>
  state.experimental.rpaEnabled;
export const selectCashFusionEnabled = (state: RootState) =>
  state.experimental.cashFusionEnabled;
export const selectNostrChatEnabled = (state: RootState) =>
  state.experimental.nostrChatEnabled !== false;
export const selectNostrRelays = createSelector(
  [(state: RootState) => state.experimental.nostrRelays],
  (relays): string[] => mergeWithDefaultRelays(relays)
);

/** True for built-in bootstrap relays (UI: no Remove button). */
export { isDefaultNostrRelay };
// Missing fields mean the wallet was persisted before these controls existed.
// Preserve opt-out semantics for Auto Fuse and normalized booleans for the mode.
export const selectAutoFuseEnabled = (state: RootState) =>
  state.experimental.autoFuseEnabled !== false;
export const selectP2pFusionEnabled = (state: RootState) =>
  state.experimental.p2pFusionEnabled === true;
/** Shared by both Fusion cards, so the two controls can never disagree. */
export const selectFuseDepth = (state: RootState) =>
  clampFuseDepth(state.experimental.fuseDepth ?? DEFAULT_FUSE_DEPTH);
/** Prefer fused coins for ordinary spends (depth ≥ 1). Default off. */
export const selectSpendOnlyFusedCoins = (state: RootState) =>
  state.experimental.spendOnlyFusedCoins === true;
export const selectFusionServer = (state: RootState) =>
  migrateDeadServer(state.experimental.fusionServer);
// Older persisted state won't have the list — fall back to the single selected
// server (migrated to the real default if it's the dead one). Memoized with
// createSelector so it returns a stable array reference; a selector that built
// a fresh array on every call breaks React-Redux's useSyncExternalStore and
// triggers an infinite render loop.
export const selectFusionServers = createSelector(
  [
    (state: RootState) => state.experimental.fusionServers,
    (state: RootState) => state.experimental.fusionServer,
    (state: RootState) => state.network.currentNetwork,
  ],
  (list, single, network): string[] => {
    const networkDefault =
      DEFAULT_FUSION_SERVERS[network] ?? DEFAULT_FUSION_SERVER;
    const persisted = (
      list && list.length > 0 ? list : [single || DEFAULT_FUSION_SERVER]
    ).map(migrateDeadServer);
    // The current network's default leads; genuine user additions (anything not
    // a known network default) are preserved so they survive network switches,
    // while the OTHER network's default is dropped from this network's pool.
    const userAdded = persisted.filter(
      (s) => !KNOWN_DEFAULT_FUSION_SERVERS.has(s)
    );
    // Offer the other servers we know about for this network, so switching to
    // one is a selection rather than retyping a host from memory. Listed after
    // the default and before user additions; the Set keeps order and dedupes.
    const alsoKnown =
      network === 'chipnet' ? KNOWN_CHIPNET_FUSION_SERVERS : [];
    return Array.from(new Set([networkDefault, ...alsoKnown, ...userAdded]));
  }
);
export const selectTorEnabled = (state: RootState) =>
  state.experimental.torEnabled !== false;
export const selectTorAuto = (state: RootState) =>
  state.experimental.torAuto !== false;
export const selectTorHost = (state: RootState) =>
  state.experimental.torHost ?? '127.0.0.1';
export const selectTorPortManual = (state: RootState) =>
  state.experimental.torPortManual ?? 9050;
// Undefined (older persisted state) counts as enabled — Quantumroot is on by default.
export const selectQuantumrootEnabled = (state: RootState) =>
  state.experimental.quantumrootEnabled !== false;
export default experimentalSlice.reducer;
