import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store';

// Electron Cash ships exactly one default fusion server (conf.py
// _get_default_server_list) — fusion.servo.cash:8789 — and it is the only one
// that actually responds (the old cashfusion.electroncash.dk entry this app
// previously shipped does not resolve at all). Everything else is user-added.
const DEFAULT_FUSION_SERVER = 'fusion.servo.cash:8789';

interface ExperimentalState {
  rpaEnabled: boolean;
  cashFusionEnabled: boolean;
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
    setFusionServer(state, action: PayloadAction<string>) {
      state.fusionServer = normalizeServer(action.payload);
    },
    addFusionServer(state, action: PayloadAction<string>) {
      const server = normalizeServer(action.payload);
      if (server && !state.fusionServers.includes(server)) {
        state.fusionServers.push(server);
      }
    },
    removeFusionServer(state, action: PayloadAction<string>) {
      const server = normalizeServer(action.payload);
      state.fusionServers = state.fusionServers.filter((s) => s !== server);
      // Never leave the selected server pointing at something no longer in the list.
      if (state.fusionServer === server) {
        state.fusionServer = state.fusionServers[0] ?? DEFAULT_FUSION_SERVER;
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
  setFusionServer,
  addFusionServer,
  removeFusionServer,
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

export const selectRpaEnabled = (state: RootState) => state.experimental.rpaEnabled;
export const selectCashFusionEnabled = (state: RootState) => state.experimental.cashFusionEnabled;
export const selectFusionServer = (state: RootState) =>
  migrateDeadServer(state.experimental.fusionServer);
// Older persisted state won't have the list — fall back to the single selected
// server (migrated to the real default if it's the dead one).
export const selectFusionServers = (state: RootState): string[] => {
  const list = state.experimental.fusionServers;
  const raw = list && list.length > 0 ? list : [state.experimental.fusionServer || DEFAULT_FUSION_SERVER];
  // Migrate the dead host and dedupe.
  return Array.from(new Set(raw.map(migrateDeadServer)));
};
export const selectTorEnabled = (state: RootState) => state.experimental.torEnabled !== false;
export const selectTorAuto = (state: RootState) => state.experimental.torAuto !== false;
export const selectTorHost = (state: RootState) => state.experimental.torHost ?? '127.0.0.1';
export const selectTorPortManual = (state: RootState) => state.experimental.torPortManual ?? 9050;
// Undefined (older persisted state) counts as enabled — Quantumroot is on by default.
export const selectQuantumrootEnabled = (state: RootState) =>
  state.experimental.quantumrootEnabled !== false;
export default experimentalSlice.reducer;
