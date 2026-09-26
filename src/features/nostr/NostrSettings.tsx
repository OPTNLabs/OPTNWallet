// Default-on Nostr chat settings: the wallet's separate Nostr identity and the
// relay pool used for chat. P2P Fusion has separate relay selection.
import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { MdAdd, MdKey, MdRefresh, MdRouter } from 'react-icons/md';

import { normalizeRelayDraft } from './nostrRelayDraft';
import type { RootState } from '../../state/store';
import {
  selectNostrRelays,
  addNostrRelay,
  removeNostrRelay,
} from '../../state/slices/experimentalSlice';
import {
  fetchProfile,
  fetchPublishedDisplayName,
  myIdentity,
  publishDisplayName,
  publishMyProfile,
} from '../../platform/desktop/nostr/chat';
import {
  claimExtraMlsDeviceSlot,
  loadMlsDeviceIndex,
  publishMlsKeyPackage,
} from '../../platform/desktop/nostr/mls';
import { useWalletConfirm } from '../../components/WalletConfirmDialog';
// Import from source of truth (not re-export) so Remove never desyncs from list.
import { isDefaultNostrRelay } from '../../platform/desktop/nostr/defaultRelays';
import { useI18n } from '../../i18n/useI18n';
import { useNostrRelayHealth } from '../../platform/desktop/nostr/useNostrRelayHealth';

export const NostrSettings: React.FC = () => {
  const dispatch = useDispatch();
  const { t } = useI18n();
  const confirm = useWalletConfirm();
  const relays = useSelector(selectNostrRelays);
  const walletId = useSelector((s: RootState) => s.wallet_id.currentWalletId);

  const [npub, setNpub] = useState<string | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [idErr, setIdErr] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [mlsDeviceIndex, setMlsDeviceIndex] = useState(0);
  const [relayDraft, setRelayDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const { health, checking, refresh: refreshRelays } = useNostrRelayHealth();
  const [loadingProfile, setLoadingProfile] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setNpub(null);
    setPubkey(null);
    setIdErr(null);
    setDisplayName('');
    setProfileMsg(null);
    if (walletId <= 0) return;
    myIdentity(walletId)
      .then(async (id) => {
        const slot = await loadMlsDeviceIndex(id.pubkey);
        if (cancelled) return;
        setNpub(id.npub);
        setPubkey(id.pubkey);
        setMlsDeviceIndex(slot);
      })
      .catch((e) => {
        if (!cancelled) setIdErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [walletId]);

  const activeCount = health.relays.filter((r) => r.reachable === true).length;

  const addRelay = () => {
    const relay = normalizeRelayDraft(relayDraft);
    if (!relay) {
      setDraftError(t('nostr.invalidRelay'));
      return;
    }
    dispatch(addNostrRelay(relay));
    setRelayDraft('');
    setDraftError('');
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Chat is available without a separate feature switch. */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3">
        <div>
          <p className="text-sm font-semibold wallet-text-strong">
            {t('nostr.chat')}
          </p>
          <p className="mt-0.5 text-[11px] wallet-muted">
            {t('nostr.dmDescription')}
          </p>
        </div>
      </div>

      <>
        {/* Identity */}
        <section className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--wallet-accent)]/15 text-[var(--wallet-accent)]">
              <MdKey className="text-xl" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold wallet-text-strong">
                {t('nostr.identity')}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed wallet-muted">
                {t('nostr.identityDescription')}
              </p>
              <div className="mt-3 rounded-lg border border-[var(--wallet-border)] px-3 py-2 font-mono text-[10px] break-all wallet-text-strong">
                {npub ?? idErr ?? t('nostr.deriving')}
              </div>
              <input
                aria-label={t('chat.displayName')}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t('chat.displayName')}
                className="wallet-input mt-3 w-full text-xs"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!pubkey || loadingProfile}
                  className="wallet-btn-secondary px-3 py-1 text-xs"
                  onClick={async () => {
                    if (!pubkey) return;
                    setLoadingProfile(true);
                    setProfileMsg(null);
                    try {
                      const [mine, publishedName] = await Promise.all([
                        fetchProfile(pubkey, relays),
                        fetchPublishedDisplayName(relays, pubkey),
                      ]);
                      setDisplayName(publishedName || mine.name || '');
                    } catch (e) {
                      setProfileMsg(e instanceof Error ? e.message : String(e));
                    } finally {
                      setLoadingProfile(false);
                    }
                  }}
                >
                  {loadingProfile
                    ? 'Loading profile…'
                    : 'Load published profile'}
                </button>
                <button
                  type="button"
                  disabled={!pubkey || loadingProfile}
                  onClick={() => {
                    void (async () => {
                      setProfileMsg(null);
                      try {
                        await Promise.all([
                          publishMyProfile(
                            walletId,
                            { name: displayName || undefined },
                            relays
                          ),
                          displayName
                            ? publishDisplayName(walletId, displayName, relays)
                            : Promise.resolve(),
                        ]);
                        setProfileMsg(t('chat.profilePublished'));
                      } catch (e) {
                        setProfileMsg(
                          e instanceof Error ? e.message : String(e)
                        );
                      }
                    })();
                  }}
                  className="wallet-btn-primary px-3 py-1 text-xs"
                >
                  {t('chat.publishProfile')}
                </button>
                {mlsDeviceIndex === 0 ? (
                  <button
                    type="button"
                    className="rounded-lg border border-[var(--wallet-border)] px-2 py-1 text-[10px] font-semibold wallet-text-strong"
                    onClick={() => {
                      if (!pubkey) return;
                      void (async () => {
                        const ok = await confirm(
                          'Only on the new install. This device becomes a separate MLS leaf (slot 1). Do not tap this on your first device.'
                        );
                        if (!ok) return;
                        try {
                          const slot = await claimExtraMlsDeviceSlot(pubkey);
                          setMlsDeviceIndex(slot);
                          await publishMlsKeyPackage(walletId, relays);
                        } catch (e) {
                          setProfileMsg(
                            e instanceof Error ? e.message : String(e)
                          );
                        }
                      })();
                    }}
                  >
                    Extra device
                  </button>
                ) : (
                  <span className="text-[10px] wallet-muted">
                    Device {mlsDeviceIndex}
                  </span>
                )}
              </div>
              {profileMsg ? (
                <p className="mt-2 text-[10px] wallet-muted">{profileMsg}</p>
              ) : null}
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
                {t('nostr.relays')}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed wallet-muted">
                Saved WSS relay endpoints for Nostr chat.
              </p>
            </div>
            <button
              type="button"
              onClick={refreshRelays}
              disabled={checking}
              className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--wallet-border)] px-2 py-1 text-[10px] font-semibold wallet-text-strong disabled:opacity-50"
              aria-label={t('nostr.checkRelayStatus')}
              title={t('nostr.checkRelayStatus')}
            >
              <MdRefresh
                className={checking ? 'animate-spin' : ''}
                aria-hidden="true"
              />
              {checking ? t('nostr.checking') : 'Check relays'}
            </button>
          </div>

          <p className="text-xs wallet-muted">
            This pool is shared across Mainnet and Chipnet. Reachability is
            checked automatically while a wallet is open, using the current
            network privacy rules. Profile actions remain explicit. Chat and
            profile connections do not yet follow the Network Tor setting.
          </p>
          {health.error && (
            <p role="status" className="text-xs wallet-muted">
              {health.error}
            </p>
          )}
          {health.relays.length > 0 && (
            <p role="status" className="text-xs wallet-muted">
              {activeCount}/{relays.length} reachable at last check
            </p>
          )}

          <div className="space-y-2">
            {relays.map((url) => {
              const result = health.relays.find((relay) => relay.url === url);
              const online = result?.reachable ?? undefined;
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
                        ? result?.reason ?? t('nostr.unknown')
                        : online
                          ? 'Reachable at last check'
                          : 'Unreachable at last check'
                    }
                  />
                  <p className="min-w-0 flex-1 truncate font-mono text-[10px] wallet-text-strong">
                    {url}
                  </p>
                  <span className="text-[10px] wallet-muted">
                    {online === undefined
                      ? 'Not checked'
                      : online
                        ? 'Reachable'
                        : 'Unreachable'}
                  </span>
                  {/* Bootstrap relays match Fulcrum seed servers: no Remove.
                        Only user-added relays can be deleted. */}
                  {!isDefaultNostrRelay(url) && (
                    <button
                      type="button"
                      onClick={() => dispatch(removeNostrRelay(url))}
                      className="shrink-0 px-1 text-[10px] text-red-400/70 hover:text-red-400"
                      aria-label={`${t('nostr.remove')} ${url}`}
                    >
                      {t('nostr.remove')}
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
                aria-label="Relay URL"
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
                {t('nostr.add')}
              </button>
            </div>
            {draftError ? (
              <p className="mt-2 text-[10px] text-red-400">{draftError}</p>
            ) : null}
          </div>
        </section>

        <section className="rounded-xl border border-yellow-400/20 bg-yellow-400/5 px-3 py-2.5">
          <p className="text-[10px] leading-relaxed text-yellow-400/90">
            {t('nostr.privacyWarning')}
          </p>
        </section>
      </>
    </div>
  );
};
