// Tor configuration, shown in the Servers panel directly below the server pool.
//
// Tor is a local SOCKS5 proxy the app connects THROUGH; it is not a server to
// add. Detection probes the standard ports (9050 daemon, 9150 Tor Browser) and
// confirms the listener is genuinely Tor. Required for remote CashFusion — a
// remote fusion server could otherwise correlate a player's coins by IP.
//
// Until the app bundles its own Tor binary, the user must run Tor themselves;
// this panel makes that state explicit.
import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectTorEnabled,
  selectTorAuto,
  selectTorHost,
  selectTorPortManual,
  setTorEnabled,
  setTorAuto,
  setTorPortManual,
} from '../../state/slices/experimentalSlice';
import {
  detectTorPort,
  FUSION_SUPPORTED,
  INTEGRATED_TOR_SUPPORTED,
  startIntegratedTor,
  stopIntegratedTor,
  integratedTorStatus,
  type ManagedTorStatus,
} from '../../services/fusion/FusionStatusService';

export const TorSettings: React.FC = () => {
  const dispatch = useDispatch();
  const torEnabled = useSelector(selectTorEnabled);
  const torAuto = useSelector(selectTorAuto);
  const torHost = useSelector(selectTorHost);
  const torPortManual = useSelector(selectTorPortManual);

  // null = not yet checked, -1 = not found, >0 = detected port.
  const [torDetected, setTorDetected] = useState<number | null>(null);
  const [torChecking, setTorChecking] = useState(false);

  // Integrated (app-managed) Tor.
  const [managed, setManaged] = useState<ManagedTorStatus>({ running: false, bootstrap_percent: 0, socks_port: 0 });
  const [torBusy, setTorBusy] = useState(false);
  const [torError, setTorError] = useState<string | null>(null);

  const refreshTor = useCallback(async () => {
    if (!FUSION_SUPPORTED || !torEnabled) return;
    setTorChecking(true);
    try {
      const port = await detectTorPort(torHost);
      setTorDetected(port ?? -1);
    } finally {
      setTorChecking(false);
    }
  }, [torEnabled, torHost]);

  const refreshManaged = useCallback(async () => {
    if (!INTEGRATED_TOR_SUPPORTED) return;
    try {
      setManaged(await integratedTorStatus());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshTor();
    void refreshManaged();
  }, [refreshTor, refreshManaged]);

  // While integrated Tor is starting, poll its bootstrap progress.
  useEffect(() => {
    if (!torBusy) return;
    const id = setInterval(() => void refreshManaged(), 1000);
    return () => clearInterval(id);
  }, [torBusy, refreshManaged]);

  const handleStartIntegrated = async () => {
    setTorBusy(true);
    setTorError(null);
    try {
      await startIntegratedTor();
      await refreshManaged();
    } catch (err) {
      setTorError(err instanceof Error ? err.message : String(err));
    } finally {
      setTorBusy(false);
    }
  };

  const handleStopIntegrated = async () => {
    setTorBusy(true);
    try {
      await stopIntegratedTor();
      await refreshManaged();
    } finally {
      setTorBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--wallet-border)] pt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">Tor</p>
          <p className="text-[10px] wallet-muted">Required for remote CashFusion servers</p>
        </div>
        <button
          onClick={() => dispatch(setTorEnabled(!torEnabled))}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
            torEnabled ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]' : 'wallet-surface-strong border-[var(--wallet-border)]'
          }`}
          aria-label={`${torEnabled ? 'Disable' : 'Enable'} Tor`}
        >
          <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${torEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {torEnabled && (
        <>
          {/* Integrated Tor — the app runs its own Tor, no external setup needed. */}
          {INTEGRATED_TOR_SUPPORTED && (
            <div className="rounded-lg border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold wallet-text-strong">Integrated Tor</p>
                  <p className="text-[10px] wallet-muted">The app runs its own Tor — no Tor Browser needed</p>
                </div>
                {managed.running ? (
                  <button
                    type="button"
                    onClick={() => void handleStopIntegrated()}
                    disabled={torBusy}
                    className="rounded-lg border border-red-400/40 px-2.5 py-1 text-[10px] font-semibold text-red-400 disabled:opacity-50"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleStartIntegrated()}
                    disabled={torBusy}
                    className="rounded-lg border border-[var(--wallet-accent)]/50 bg-[var(--wallet-accent)]/10 px-2.5 py-1 text-[10px] font-semibold text-[var(--wallet-accent)] disabled:opacity-50"
                  >
                    {torBusy ? 'Starting…' : 'Start integrated Tor'}
                  </button>
                )}
              </div>
              {managed.running ? (
                <p className="text-[10px] text-green-400 font-semibold">Running on port {managed.socks_port} ✓</p>
              ) : torBusy ? (
                <p className="text-[10px] wallet-muted">Bootstrapping Tor… {managed.bootstrap_percent}%</p>
              ) : null}
              {torError && <p className="text-[10px] text-red-400/80 leading-relaxed">{torError}</p>}
            </div>
          )}

          <p className="text-[10px] wallet-muted">Or use a Tor you run yourself:</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => dispatch(setTorAuto(true))}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-[10px] font-semibold transition-colors ${
                torAuto ? 'border-[var(--wallet-accent)]/50 bg-[var(--wallet-accent)]/10 text-[var(--wallet-accent)]' : 'border-[var(--wallet-border)] wallet-muted'
              }`}
            >
              Auto-detect (9050 / 9150)
            </button>
            <button
              type="button"
              onClick={() => dispatch(setTorAuto(false))}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-[10px] font-semibold transition-colors ${
                !torAuto ? 'border-[var(--wallet-accent)]/50 bg-[var(--wallet-accent)]/10 text-[var(--wallet-accent)]' : 'border-[var(--wallet-border)] wallet-muted'
              }`}
            >
              Manual port
            </button>
          </div>

          {!torAuto && (
            <input
              type="number"
              value={torPortManual}
              onChange={(e) => dispatch(setTorPortManual(Number(e.target.value) || 9050))}
              placeholder="9050"
              className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-2 font-mono text-xs wallet-text-strong focus:outline-none focus:border-[var(--wallet-accent)]/60"
            />
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshTor()}
              disabled={torChecking || !FUSION_SUPPORTED}
              className="rounded-lg border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-2.5 py-1 text-[10px] font-semibold wallet-text-strong disabled:opacity-50"
            >
              {torChecking ? 'Checking…' : 'Check Tor'}
            </button>
            {!FUSION_SUPPORTED ? (
              <span className="text-[10px] wallet-muted">Desktop only</span>
            ) : torAuto && torDetected !== null ? (
              torDetected > 0 ? (
                <span className="text-[10px] text-green-400 font-semibold">Tor found on port {torDetected} ✓</span>
              ) : (
                <span className="text-[10px] text-red-400 font-semibold">No Tor proxy running ✗</span>
              )
            ) : (
              <span className="text-[10px] wallet-muted">Using manual port {torPortManual}</span>
            )}
          </div>

          {torAuto && torDetected === -1 && (
            <p className="text-[10px] text-yellow-400/80 leading-relaxed">
              No Tor found. Start Tor Browser (port 9150) or a system Tor daemon (9050), then press
              “Check Tor”. A bundled, auto-started Tor is planned so this works out of the box.
              Without Tor, remote CashFusion is blocked.
            </p>
          )}
        </>
      )}
    </div>
  );
};
