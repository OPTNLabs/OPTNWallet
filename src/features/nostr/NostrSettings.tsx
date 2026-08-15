// Default-on Nostr chat settings: the wallet's separate Nostr identity and the
// relay pool used for chat plus the P2P-fusion transport.
import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { MdAdd, MdKey, MdRefresh, MdRouter } from 'react-icons/md';

import { normalizeRelayDraft } from './nostrRelayDraft';
import type { RootState } from '../../state/store';
import {
  selectNostrChatEnabled,
  selectNostrRelays,
  setNostrChatEnabled,
  addNostrRelay,
  removeNostrRelay,
} from '../../state/slices/experimentalSlice';
import {
  myIdentity,
  checkRelayStatus,
} from '../../platform/desktop/nostr/chat';
// Import from source of truth (not re-export) so Remove never desyncs from list.
import { isDefaultNostrRelay } from '../../platform/desktop/nostr/defaultRelays';

export const NostrSettings: React.FC = () => {
  const dispatch = useDispatch();
  const enabled = useSelector(selectNostrChatEnabled);
  const relays = useSelector(selectNostrRelays);
  const walletId = useSelector((s: RootState) => s.wallet_id.currentWalletId);

  const [npub, setNpub] = useState<string | null>(null);
  const [idErr, setIdErr] = useState<string | null>(null);
  const [relayDraft, setRelayDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const [relayStatus, setRelayStatus] = useState<Record<string, boolean>>({});
  const [checking, setChecking] = useState(false);
  /** How often to re-probe while this screen is open (remote relays flap). */
  const RELAY_HEALTH_INTERVAL_MS = 45_000;

  useEffect(() => {
    if (!enabled || walletId <= 0) return;
    myIdentity(walletId)
      .then((id) => setNpub(id.npub))
      .catch((e) => setIdErr(e instanceof Error ? e.message : String(e)));
  }, [enabled, walletId]);

  // Auto health probe: on open, on interval, on tab focus — not only Sync click.
  // We cannot keep third-party relays "up"; we only re-measure reachability.
  const refreshRelays = useCallback(() => {
    if (relays.length === 0) return;
    setChecking(true);
    checkRelayStatus(relays, 8_000, (url, online) => {
      setRelayStatus((prev) => ({ ...prev, [url]: online }));
    })
      .then(setRelayStatus)
      .finally(() => setChecking(false));
  }, [relays]);

  useEffect(() => {
    if (!enabled || relays.length === 0) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      refreshRelays();
    };
    run();
    const interval = window.setInterval(run, RELAY_HEALTH_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, relays, refreshRelays]);

  const activeCount = relays.filter((r) => relayStatus[r] === true).length;
  const knownCount = relays.filter((r) => relayStatus[r] !== undefined).length;

  const addRelay = () => {
    const relay = normalizeRelayDraft(relayDraft);
    if (!relay) {
      setDraftError('Enter a secure relay URL beginning with wss://');
      return;
    }
    dispatch(addNostrRelay(relay));
    setRelayDraft('');
    setDraftError('');
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Enable toggle */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3">
        <div>
          <p className="text-sm font-semibold wallet-text-strong">Nostr chat</p>
          <p className="mt-0.5 text-[11px] wallet-muted">
            End-to-end encrypted DMs using NIP-17.
          </p>
        </div>
        <button
          onClick={() => dispatch(setNostrChatEnabled(!enabled))}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
            enabled
              ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
              : 'wallet-surface-strong border-[var(--wallet-border)]'
          }`}
          aria-label={`${enabled ? 'Disable' : 'Enable'} Nostr chat`}
        >
          <span
            className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`}
          />
        </button>
      </div>

      {enabled && (
        <>
          {/* Identity */}
          <section className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4">
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--wallet-accent)]/15 text-[var(--wallet-accent)]">
                <MdKey className="text-xl" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold wallet-text-strong">
                  Nostr identity
                </p>
                <p className="mt-1 text-[11px] leading-relaxed wallet-muted">
                  Derived from your seed via NIP-06 (a separate path) — your
                  spending keys are never reused.
                </p>
                <div className="mt-3 rounded-lg border border-[var(--wallet-border)] px-3 py-2 font-mono text-[10px] break-all wallet-text-strong">
                  {npub ?? idErr ?? 'Deriving…'}
                </div>
              </div>
            </div>
          </section>

          {/* Relays */}
          <section className="space-y-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4">
            <div className="flex items-start gap-3">
              <MdRouter
                className="mt-0.5 shrink-0 text-xl text-[var(--wallet-accent)]"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold wallet-text-strong">
                  Relays
                </p>
                <p className="mt-1 text-[11px] leading-relaxed wallet-muted">
                  WSS relays for chat and P2P fusion. Status auto-refreshes
                  about every 45s (and when you reopen this screen). Green =
                  reachable right now — we cannot force third-party servers to
                  stay online. Fusion still works if some are red (multi-relay).
                </p>
              </div>
              <button
                type="button"
                onClick={refreshRelays}
                disabled={checking}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--wallet-border)] px-2 py-1 text-[10px] font-semibold wallet-text-strong disabled:opacity-50"
                aria-label="Check relay status now"
                title="Optional manual re-check; health also runs automatically"
              >
                <MdRefresh
                  className={checking ? 'animate-spin' : ''}
                  aria-hidden="true"
                />
                {checking
                  ? `Checking… ${knownCount}/${relays.length}`
                  : `${activeCount}/${relays.length} up`}
              </button>
            </div>

            <div className="space-y-2">
              {relays.map((url) => {
                const online = relayStatus[url];
                return (
                  <div
                    key={url}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[var(--wallet-border)] px-3 py-2"
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        online === undefined
                          ? 'bg-[var(--wallet-border)]'
                          : online
                            ? 'bg-green-400'
                            : 'bg-red-400/70'
                      }`}
                      title={
                        online === undefined
                          ? 'unknown'
                          : online
                            ? 'connected'
                            : 'unreachable'
                      }
                    />
                    <p className="min-w-0 flex-1 truncate font-mono text-[10px] wallet-text-strong">
                      {url}
                    </p>
                    {/* Bootstrap relays match Fulcrum seed servers: no Remove.
                        Only user-added relays can be deleted. */}
                    {!isDefaultNostrRelay(url) && (
                      <button
                        type="button"
                        onClick={() => dispatch(removeNostrRelay(url))}
                        className="shrink-0 px-1 text-[10px] text-red-400/70 hover:text-red-400"
                        aria-label={`Remove ${url}`}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="border-t border-[var(--wallet-border)] pt-3">
              <div className="flex gap-2">
                <input
                  type="url"
                  value={relayDraft}
                  onChange={(e) => setRelayDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addRelay()}
                  placeholder="wss://relay.example.com"
                  className="wallet-input min-w-0 flex-1 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={addRelay}
                  className="flex items-center gap-1 rounded-xl border border-[var(--wallet-accent)]/40 px-3 py-2 text-xs font-semibold text-[var(--wallet-accent)]"
                >
                  <MdAdd aria-hidden="true" />
                  Add
                </button>
              </div>
              {draftError ? (
                <p className="mt-2 text-[10px] text-red-400">{draftError}</p>
              ) : null}
            </div>
          </section>

          <section className="rounded-xl border border-yellow-400/20 bg-yellow-400/5 px-3 py-2.5">
            <p className="text-[10px] leading-relaxed text-yellow-400/90">
              Relay operators can still observe connection metadata, timing, and
              recipient tags. Encrypted content is not the same as network
              anonymity.
            </p>
          </section>
        </>
      )}
    </div>
  );
};
