// Settings → Addons: install/list/uninstall third-party ('iframe-bundle')
// addons. Desktop-only for now (no filesystem-drop UX on mobile yet) — the
// underlying service throws a clear error if called on mobile/web, and this
// panel hides the install affordance outside of non-packaged-mobile runtimes
// (same isNativePlatform() gate MarketplaceAppHost already uses for
// desktop-vs-packaged-mobile distinctions).
import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  installAddonFromDirectory,
  listInstalledAddons,
  uninstallAddon,
  type InstalledAddonSummary,
} from '../../services/addons/AddonInstallService';

export function AddonsSettings() {
  const [addons, setAddons] = useState<InstalledAddonSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const isDesktopOrWeb = !Capacitor.isNativePlatform();

  const refresh = useCallback(async () => {
    try {
      setAddons(await listInstalledAddons());
    } catch {
      setAddons([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInstall = async () => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const manifest = await installAddonFromDirectory();
      if (!manifest) {
        setBusy(false);
        return; // user cancelled the dialog
      }
      setStatus(`Installed "${manifest.name}". Restart the app to load it.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleUninstall = async (id: string) => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await uninstallAddon(id);
      setStatus('Uninstalled. Restart the app for it to fully disappear.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-2">
        <p className="text-sm font-semibold wallet-text-strong">Installed addons</p>
        <p className="text-xs wallet-muted leading-relaxed">
          Addons run in a sandboxed frame with no access to your wallet's keys
          or memory — they can only do what the permissions you approve allow.
        </p>

        {addons.length === 0 ? (
          <p className="text-xs wallet-muted italic">No addons installed.</p>
        ) : (
          <ul className="space-y-2">
            {addons.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-[var(--wallet-border)] px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium wallet-text-strong truncate">{a.name}</p>
                  <p className="text-xs wallet-muted">
                    {a.id} · v{a.version}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleUninstall(a.id)}
                  className="shrink-0 rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-semibold text-red-400 disabled:opacity-50"
                >
                  Uninstall
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {isDesktopOrWeb ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleInstall()}
          className="w-full rounded-xl py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: 'var(--wallet-accent, #6366f1)' }}
        >
          {busy ? 'Installing…' : 'Install from folder…'}
        </button>
      ) : (
        <p className="text-xs wallet-muted italic">
          Installing addons from a folder is only available on desktop.
        </p>
      )}

      {status && <p className="text-xs text-green-400">{status}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
