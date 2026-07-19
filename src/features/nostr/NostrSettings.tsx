import React, { useState } from 'react';
import { MdAdd, MdKey, MdLockOutline, MdRouter } from 'react-icons/md';
import { normalizeRelayDraft } from './nostrRelayDraft';

type DraftRelay = {
  url: string;
  role: 'Private messages' | 'General';
};

export const NostrSettings: React.FC = () => {
  const [relayDraft, setRelayDraft] = useState('');
  const [draftRelays, setDraftRelays] = useState<DraftRelay[]>([]);
  const [draftError, setDraftError] = useState('');

  const addDraftRelay = () => {
    const relay = normalizeRelayDraft(relayDraft);
    if (!relay) {
      setDraftError('Enter a secure relay URL beginning with wss://');
      return;
    }
    if (!draftRelays.some((item) => item.url === relay)) {
      setDraftRelays((items) => [...items, { url: relay, role: 'Private messages' }]);
    }
    setRelayDraft('');
    setDraftError('');
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-violet-400/20 bg-violet-400/5 p-3">
        <div className="flex items-center gap-2">
          <MdLockOutline className="text-violet-400" aria-hidden="true" />
          <p className="text-xs font-semibold text-violet-400">NIP-17 private chat</p>
          <span className="rounded-full border border-yellow-400/30 bg-yellow-400/10 px-2 py-0.5 text-[9px] font-bold uppercase text-yellow-400">
            UI preview
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed wallet-muted">
          The interface is ready for NIP-44 encrypted, NIP-59 gift-wrapped messages.
          This build does not generate a Nostr key, connect to relays, or send events.
        </p>
      </section>

      <section className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--wallet-accent)]/15 text-[var(--wallet-accent)]">
            <MdKey className="text-xl" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold wallet-text-strong">Nostr identity</p>
              <span className="text-[10px] font-semibold text-yellow-400">Not created</span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed wallet-muted">
              Chat will use a domain-separated identity. Your BCH seed and spending
              keys will never be reused as Nostr keys.
            </p>
            <div className="mt-3 rounded-lg border border-dashed border-[var(--wallet-border)] px-3 py-2 font-mono text-[10px] wallet-muted">
              npub1… identity will appear here
            </div>
            <button
              type="button"
              disabled
              className="mt-3 w-full rounded-xl border border-[var(--wallet-accent)]/40 px-3 py-2 text-xs font-semibold text-[var(--wallet-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Identity activation pending security review
            </button>
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4">
        <div className="flex items-start gap-3">
          <MdRouter className="mt-0.5 shrink-0 text-xl text-[var(--wallet-accent)]" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold wallet-text-strong">Automatic relay pool</p>
            <p className="mt-1 text-[11px] leading-relaxed wallet-muted">
              Public relay discovery will use NIP-65. Private-message delivery will
              use each recipient&apos;s NIP-17 kind 10050 relay list (recommended 1–3).
            </p>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-[var(--wallet-border)] px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold wallet-text-strong">General relays</span>
              <span className="text-[9px] text-yellow-400">Waiting</span>
            </div>
            <p className="mt-1 text-[10px] wallet-muted">Discovered from signed NIP-65 lists</p>
          </div>
          <div className="rounded-lg border border-[var(--wallet-border)] px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold wallet-text-strong">DM relays</span>
              <span className="text-[9px] text-yellow-400">0 / 3</span>
            </div>
            <p className="mt-1 text-[10px] wallet-muted">Published with kind 10050</p>
          </div>
        </div>

        <div className="border-t border-[var(--wallet-border)] pt-3">
          <label htmlFor="nostr-relay-draft" className="text-xs font-semibold wallet-text-strong">
            Add your relay
          </label>
          <p className="mt-1 text-[10px] wallet-muted">
            Preview-only drafts are not persisted and are never contacted.
          </p>
          <div className="mt-2 flex gap-2">
            <input
              id="nostr-relay-draft"
              type="url"
              value={relayDraft}
              onChange={(event) => setRelayDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addDraftRelay();
              }}
              placeholder="wss://relay.example.com"
              className="wallet-input min-w-0 flex-1 font-mono text-xs"
            />
            <button
              type="button"
              onClick={addDraftRelay}
              className="flex items-center gap-1 rounded-xl border border-[var(--wallet-accent)]/40 px-3 py-2 text-xs font-semibold text-[var(--wallet-accent)]"
            >
              <MdAdd aria-hidden="true" />
              Draft
            </button>
          </div>
          {draftError ? <p className="mt-2 text-[10px] text-red-400">{draftError}</p> : null}
          {draftRelays.length > 0 ? (
            <div className="mt-3 space-y-2">
              {draftRelays.map((relay) => (
                <div key={relay.url} className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-[var(--wallet-border)] px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[10px] wallet-text-strong">{relay.url}</p>
                    <p className="text-[9px] wallet-muted">{relay.role}</p>
                  </div>
                  <span className="shrink-0 text-[9px] font-semibold text-yellow-400">Draft · offline</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-xl border border-yellow-400/20 bg-yellow-400/5 px-3 py-2.5">
        <p className="text-[10px] leading-relaxed text-yellow-400/90">
          Relay operators can still observe connection metadata, timing, volume, and
          recipient tags. Encrypted content is not the same as network anonymity.
        </p>
      </section>
    </div>
  );
};
