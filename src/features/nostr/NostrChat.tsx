import React, { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  MdAdd,
  MdArrowBack,
  MdChatBubbleOutline,
  MdLockOutline,
  MdSearch,
  MdSettings,
} from 'react-icons/md';

import PageHeader from '../../components/ui/PageHeader';
import WalletScreen from '../../components/ui/WalletScreen';

const SETUP_CONVERSATION_ID = 'setup';

const StatusPill: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="rounded-full border border-yellow-400/30 bg-yellow-400/10 px-2 py-1 text-[10px] font-semibold text-yellow-400">
    {children}
  </span>
);

const SetupConversation: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <section className="flex h-full min-h-0 flex-col">
    <header className="flex items-center gap-3 border-b border-[var(--wallet-border)] px-4 py-3">
      <button
        type="button"
        onClick={onBack}
        className="rounded-full p-2 wallet-surface-strong wallet-text-strong md:hidden"
        aria-label="Back to conversations"
      >
        <MdArrowBack aria-hidden="true" />
      </button>
      <div className="grid h-10 w-10 place-items-center rounded-full bg-[var(--wallet-accent)]/15 text-[var(--wallet-accent)]">
        <MdLockOutline className="text-xl" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-bold wallet-text-strong">Private chat setup</h2>
        <p className="truncate text-[11px] wallet-muted">Local onboarding · no relay connection</p>
      </div>
      <StatusPill>Preview</StatusPill>
    </header>

    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <div className="mx-auto max-w-sm rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3 text-center">
        <p className="text-xs font-semibold wallet-text-strong">End-to-end private messaging</p>
        <p className="mt-1 text-[11px] leading-relaxed wallet-muted">
          This conversation shell is ready for NIP-17 gift-wrapped messages using
          NIP-44 encryption and NIP-59 envelopes. Transport is intentionally off.
        </p>
      </div>

      <div className="max-w-[82%] rounded-2xl rounded-tl-md border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-2.5">
        <p className="text-xs leading-relaxed wallet-text-strong">
          First create a Nostr identity that is separate from your BCH spending keys.
        </p>
        <p className="mt-1 text-[9px] wallet-muted">Setup assistant · local only</p>
      </div>

      <div className="ml-auto max-w-[82%] rounded-2xl rounded-tr-md border border-[var(--wallet-accent)]/30 bg-[var(--wallet-accent)]/10 px-3 py-2.5">
        <p className="text-xs leading-relaxed wallet-text-strong">
          Then choose 1–3 private-message relays or add your own relay in Settings.
        </p>
        <p className="mt-1 text-right text-[9px] wallet-muted">Planned flow</p>
      </div>

      <div className="max-w-[82%] rounded-2xl rounded-tl-md border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-2.5">
        <p className="text-xs leading-relaxed wallet-text-strong">
          Sending stays disabled until event verification, replay protection, relay
          authentication, and encrypted delivery acknowledgements are implemented.
        </p>
        <p className="mt-1 text-[9px] wallet-muted">Safety gate</p>
      </div>
    </div>

    <footer className="border-t border-[var(--wallet-border)] p-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          disabled
          placeholder="Messaging transport is not active yet"
          className="wallet-input min-w-0 flex-1 text-xs disabled:cursor-not-allowed disabled:opacity-60"
          aria-label="Message composer unavailable"
        />
        <button
          type="button"
          disabled
          className="rounded-xl bg-[var(--wallet-accent)] px-4 py-3 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </div>
      <p className="mt-2 text-center text-[9px] wallet-muted">
        No key is generated, no relay is contacted, and no message leaves this device.
      </p>
    </footer>
  </section>
);

const NostrChat: React.FC = () => {
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId?: string }>();
  const [query, setQuery] = useState('');
  const showConversation = conversationId === SETUP_CONVERSATION_ID;
  const setupVisible = useMemo(
    () => 'private chat setup'.includes(query.trim().toLowerCase()),
    [query]
  );

  return (
    <WalletScreen maxWidthClassName="max-w-5xl" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-3">
        <PageHeader title="Chat" compact />
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight wallet-text-strong">Chat</h1>
            <p className="text-xs wallet-muted">Private Nostr messaging</p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/settings?panel=nostr')}
            className="flex items-center gap-2 rounded-xl border border-[var(--wallet-border)] px-3 py-2 text-xs font-semibold wallet-text-strong"
          >
            <MdSettings aria-hidden="true" />
            Nostr setup
          </button>
        </div>

        <div className="wallet-card grid min-h-0 flex-1 overflow-hidden md:grid-cols-[minmax(240px,0.38fr)_minmax(0,1fr)]">
          <aside className={`${showConversation ? 'hidden md:flex' : 'flex'} min-h-0 flex-col border-r border-[var(--wallet-border)]`}>
            <div className="space-y-3 border-b border-[var(--wallet-border)] p-3">
              <div className="flex items-center gap-2">
                <label className="wallet-input flex min-w-0 flex-1 items-center gap-2 py-1.5">
                  <MdSearch className="shrink-0 wallet-muted" aria-hidden="true" />
                  <span className="sr-only">Search conversations</span>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search conversations"
                    className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:wallet-muted"
                  />
                </label>
                <button
                  type="button"
                  disabled
                  className="grid h-11 w-11 place-items-center rounded-xl border border-[var(--wallet-border)] text-[var(--wallet-accent)] disabled:cursor-not-allowed disabled:opacity-45"
                  aria-label="New chat unavailable"
                  title="Available after Nostr identity and relay setup"
                >
                  <MdAdd className="text-xl" aria-hidden="true" />
                </button>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider wallet-muted">Messages</span>
                <StatusPill>Offline</StatusPill>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {setupVisible ? (
                <button
                  type="button"
                  onClick={() => navigate(`/chat/${SETUP_CONVERSATION_ID}`)}
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                    showConversation
                      ? 'border-[var(--wallet-accent)]/40 bg-[var(--wallet-accent)]/10'
                      : 'border-transparent hover:bg-[var(--wallet-surface)]'
                  }`}
                >
                  <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--wallet-accent)]/15 text-[var(--wallet-accent)]">
                    <MdLockOutline className="text-xl" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold wallet-text-strong">Private chat setup</span>
                      <span className="text-[9px] wallet-muted">Now</span>
                    </div>
                    <p className="truncate text-[11px] wallet-muted">Finish identity and relay setup</p>
                  </div>
                </button>
              ) : (
                <div className="grid h-full place-items-center p-6 text-center">
                  <p className="text-xs wallet-muted">No matching conversations</p>
                </div>
              )}
            </div>
          </aside>

          <main className={`${showConversation ? 'flex' : 'hidden md:flex'} min-h-0 flex-col`}>
            {showConversation ? (
              <SetupConversation onBack={() => navigate('/chat')} />
            ) : (
              <div className="grid h-full place-items-center p-8 text-center">
                <div className="max-w-xs">
                  <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[var(--wallet-accent)]/15 text-[var(--wallet-accent)]">
                    <MdChatBubbleOutline className="text-3xl" aria-hidden="true" />
                  </div>
                  <h2 className="mt-4 text-base font-bold wallet-text-strong">Your private conversations</h2>
                  <p className="mt-2 text-xs leading-relaxed wallet-muted">
                    Select the setup conversation to preview the encrypted-chat flow.
                    Real contacts and messages will appear here after activation.
                  </p>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </WalletScreen>
  );
};

export default NostrChat;
