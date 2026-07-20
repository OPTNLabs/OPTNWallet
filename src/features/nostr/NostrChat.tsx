// Nostr chat — a working NIP-17 private-message client. Enter someone's npub,
// see their profile (name + picture) if they've published one, and exchange
// end-to-end encrypted DMs over the wallet's Nostr identity + relays.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { MdArrowBack, MdContentCopy, MdSend } from 'react-icons/md';

import PageHeader from '../../components/ui/PageHeader';
import WalletScreen from '../../components/ui/WalletScreen';
import type { RootState } from '../../state/store';
import { selectNostrRelays } from '../../state/slices/experimentalSlice';
import {
  myIdentity,
  sendDirectMessage,
  subscribeMessages,
  fetchProfile,
  publishMyProfile,
  toPubkeyHex,
  type ChatMessage,
  type NostrProfile,
} from '../../platform/desktop/nostr/chat';

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s);

const Avatar: React.FC<{ url?: string; fallback: string }> = ({ url, fallback }) => (
  <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--wallet-border)] bg-[var(--wallet-surface)] text-xs font-bold wallet-muted">
    {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : fallback.slice(0, 2).toUpperCase()}
  </div>
);

const NostrChat: React.FC = () => {
  const navigate = useNavigate();
  const walletId = useSelector((s: RootState) => s.wallet_id.currentWalletId);
  const relays = useSelector(selectNostrRelays);

  const [me, setMe] = useState<{ pubkey: string; npub: string } | null>(null);
  const [recipient, setRecipient] = useState('');
  const [peer, setPeer] = useState<string | null>(null);
  const [peerProfile, setPeerProfile] = useState<NostrProfile | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Self profile editor.
  const [showProfile, setShowProfile] = useState(false);
  const [myName, setMyName] = useState('');
  const [myPicture, setMyPicture] = useState('');
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (walletId <= 0) return;
    myIdentity(walletId).then(setMe).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [walletId]);

  // One subscription for all my DMs; the thread view filters to the open peer.
  useEffect(() => {
    if (walletId <= 0) return;
    const unsub = subscribeMessages(
      walletId,
      (m) =>
        setMessages((prev) =>
          prev.some((x) => x.id === m.id) ? prev : [...prev, m].sort((a, b) => a.at - b.at)
        ),
      relays
    );
    return unsub;
  }, [walletId, relays]);

  const thread = useMemo(() => {
    if (!peer) return [];
    return messages.filter((m) => m.from === peer || (m.mine && m.to.includes(peer)));
  }, [messages, peer]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread.length]);

  const openConversation = useCallback(async () => {
    setErr(null);
    try {
      const hex = toPubkeyHex(recipient);
      setPeer(hex);
      setPeerProfile({ pubkey: hex });
      const p = await fetchProfile(hex, relays);
      setPeerProfile(p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [recipient, relays]);

  const send = useCallback(async () => {
    if (!peer || !draft.trim() || walletId <= 0) return;
    setSending(true);
    setErr(null);
    try {
      await sendDirectMessage(walletId, peer, draft.trim(), relays);
      setDraft('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [peer, draft, walletId, relays]);

  const saveProfile = useCallback(async () => {
    setProfileMsg(null);
    try {
      await publishMyProfile(walletId, { name: myName || undefined, picture: myPicture || undefined }, relays);
      setProfileMsg('Profile published ✓');
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : String(e));
    }
  }, [walletId, myName, myPicture, relays]);

  const peerName = peerProfile?.name || (peer ? short(peer) : '');

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-3">
        <PageHeader
          title="Chat"
          subtitle="Encrypted over Nostr"
          titleAction={
            <button onClick={() => navigate(-1)} aria-label="Back" className="wallet-icon-btn">
              <MdArrowBack />
            </button>
          }
          compact
        />

        {/* My identity + profile */}
        {me && (
          <div className="rounded-xl border border-[var(--wallet-border)] wallet-surface px-3 py-2 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] wallet-muted">Your npub</p>
                <p className="truncate font-mono text-[11px] wallet-text-strong">{me.npub}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => void navigator.clipboard.writeText(me.npub)}
                  className="wallet-icon-btn"
                  aria-label="Copy npub"
                >
                  <MdContentCopy />
                </button>
                <button
                  onClick={() => setShowProfile((v) => !v)}
                  className="rounded-lg border border-[var(--wallet-border)] px-2 py-1 text-[10px] font-semibold wallet-text-strong"
                >
                  Profile
                </button>
              </div>
            </div>
            {showProfile && (
              <div className="space-y-1.5 border-t border-[var(--wallet-border)] pt-2">
                <input
                  value={myName}
                  onChange={(e) => setMyName(e.target.value)}
                  placeholder="Display name"
                  className="wallet-input w-full text-xs"
                />
                <input
                  value={myPicture}
                  onChange={(e) => setMyPicture(e.target.value)}
                  placeholder="Picture URL (https://…)"
                  className="wallet-input w-full text-xs"
                />
                <div className="flex items-center justify-between gap-2">
                  <button onClick={() => void saveProfile()} className="wallet-btn-primary px-3 py-1 text-xs">
                    Publish profile
                  </button>
                  {profileMsg && <span className="text-[10px] wallet-muted">{profileMsg}</span>}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Recipient picker */}
        <div className="flex items-center gap-2">
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Recipient npub…"
            className="wallet-input flex-1 text-xs font-mono"
            onKeyDown={(e) => e.key === 'Enter' && void openConversation()}
          />
          <button onClick={() => void openConversation()} className="wallet-btn-primary px-3 py-2 text-xs">
            Open
          </button>
        </div>

        {err && <p className="text-[10px] text-red-400/90 break-all">{err}</p>}

        {/* Conversation */}
        {peer && (
          <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-[var(--wallet-border)] wallet-surface">
            <div className="flex items-center gap-2 border-b border-[var(--wallet-border)] px-3 py-2">
              <Avatar url={peerProfile?.picture} fallback={peerName} />
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold wallet-text-strong">{peerName}</p>
                {peerProfile?.nip05 && <p className="truncate text-[10px] wallet-muted">{peerProfile.nip05}</p>}
              </div>
            </div>

            <div className="flex-1 min-h-0 space-y-1.5 overflow-y-auto p-3">
              {thread.length === 0 ? (
                <p className="text-center text-[10px] wallet-muted pt-6">
                  No messages yet. Say hi — messages are end-to-end encrypted.
                </p>
              ) : (
                thread.map((m) => (
                  <div key={m.id} className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-xs ${
                        m.mine
                          ? 'bg-[var(--wallet-accent)]/15 text-[var(--wallet-accent-strong)]'
                          : 'wallet-card wallet-text-strong'
                      }`}
                    >
                      {m.text}
                    </div>
                  </div>
                ))
              )}
              <div ref={bottomRef} />
            </div>

            <div className="flex items-center gap-2 border-t border-[var(--wallet-border)] p-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Message…"
                className="wallet-input flex-1 text-xs"
                onKeyDown={(e) => e.key === 'Enter' && void send()}
                disabled={sending}
              />
              <button
                onClick={() => void send()}
                disabled={sending || !draft.trim()}
                className="wallet-btn-primary grid h-9 w-9 place-items-center disabled:opacity-50"
                aria-label="Send"
              >
                <MdSend />
              </button>
            </div>
          </div>
        )}
      </div>
    </WalletScreen>
  );
};

export default NostrChat;
