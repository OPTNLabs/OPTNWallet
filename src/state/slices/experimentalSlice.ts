import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { createSelector } from 'reselect';
import type { RootState } from '../store';

// Electron Cash ships exactly one default fusion server (conf.py
// _get_default_server_list) — fusion.servo.cash:8789 — and it is the only one
// that actually responds (the old cashfusion.electroncash.dk entry this app
// previously shipped does not resolve at all). Everything else is user-added.
const DEFAULT_FUSION_SERVER = 'fusion.servo.cash:8789';

// The default fusion server follows the active network: mainnet uses Electron
// Cash's fusion.servo.cash:8789; Chipnet uses kalasti's chipnet.bch.ninja:8789.
// Keyed by the Network enum's string values ('mainnet' | 'chipnet').
const DEFAULT_FUSION_SERVERS: Record<string, string> = {
  mainnet: DEFAULT_FUSION_SERVER,
  chipnet: 'chipnet.bch.ninja:8789',
};
const KNOWN_DEFAULT_FUSION_SERVERS = new Set(
  Object.values(DEFAULT_FUSION_SERVERS)
);

// Starter Nostr relays for chat + the P2P-fusion transport. Plain WSS, opened
// directly by the WebView. Users can add their own.
const DEFAULT_NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

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
  // before the engine leaves it alone. EC treats 0 as "keep fusing forever";
  // we default to 3 so auto-fusion terminates on its own rather than spending
  // fees indefinitely without the user asking.
  fuseDepth: number;
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
    nostrChatEnabled: defaultOnAlreadyApplied
      ? persisted.nostrChatEnabled !== false
      : true,
    nostrChatDefaultOnApplied: true,
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
      state.nostrRelays = state.nostrRelays.filter(
        (r) => r !== action.payload.trim()
      );
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
      // "no peers" rather than as a broken setting.
      if (action.payload.length > 0) state.nostrRelays = action.payload;
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
  (relays): string[] =>
    relays && relays.length > 0 ? relays : [...DEFAULT_NOSTR_RELAYS]
);
// Missing fields mean the wallet was persisted before these controls existed.
// Preserve opt-out semantics for Auto Fuse and normalized booleans for the mode.
export const selectAutoFuseEnabled = (state: RootState) =>
  state.experimental.autoFuseEnabled !== false;
export const selectP2pFusionEnabled = (state: RootState) =>
  state.experimental.p2pFusionEnabled === true;
/** Shared by both Fusion cards, so the two controls can never disagree. */
export const selectFuseDepth = (state: RootState) =>
  clampFuseDepth(state.experimental.fuseDepth ?? DEFAULT_FUSE_DEPTH);
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
    return Array.from(new Set([networkDefault, ...userAdded]));
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
