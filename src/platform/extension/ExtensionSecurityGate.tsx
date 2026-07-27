// Lock screen shown in front of the wallet inside the extension popup.
// Every popup open starts locked — there is no persistent background
// component holding a key, so re-prompting here is the correct behavior,
// not a workaround (see docs/browser-extension-scope.md).
import React, { useEffect, useState } from 'react';
import ExtensionKeyManager from './ExtensionKeyManager';

const ExtensionSecurityGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [ready, setReady] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNeedsSetup(!ExtensionKeyManager.hasSetup());
    setReady(true);
  }, []);

  if (!ready) return null;
  if (unlocked) return <>{children}</>;

  async function handleSetup(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (passphrase.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await ExtensionKeyManager.setup(passphrase);
      setUnlocked(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const ok = await ExtensionKeyManager.unlock(passphrase);
      if (ok) setUnlocked(true);
      else setError('Incorrect password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col items-center justify-center gap-4 bg-[#101828] p-6 text-white">
      <div className="text-lg font-semibold">OPTN Wallet</div>
      {needsSetup ? (
        <form onSubmit={handleSetup} className="flex w-full max-w-xs flex-col gap-3">
          <p className="text-center text-sm text-white/70">
            Set a password to protect this wallet. It re-locks every time you close this popup.
          </p>
          <input
            type="password"
            autoFocus
            placeholder="New password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm outline-none"
          />
          <input
            type="password"
            placeholder="Confirm password"
            value={confirmPassphrase}
            onChange={(e) => setConfirmPassphrase(e.target.value)}
            className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm outline-none"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? 'Setting up…' : 'Set password'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleUnlock} className="flex w-full max-w-xs flex-col gap-3">
          <input
            type="password"
            autoFocus
            placeholder="Password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm outline-none"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
      )}
    </div>
  );
};

export default ExtensionSecurityGate;
