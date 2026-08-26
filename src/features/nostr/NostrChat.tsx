// Nostr chat — a working NIP-17 private-message client in the two-pane messenger
// layout: a conversation list on the left, the open thread on the right (single
// pane on mobile). Messages are end-to-end encrypted (NIP-17 gift-wrap); the
// wallet's Nostr identity signs. Profiles (name + picture) are shown for each
// peer, and you can set your own — with the avatar picked from your device.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import {
  MdAdd,
  MdArrowBack,
  MdChatBubbleOutline,
  MdContentCopy,
  MdImage,
  MdSearch,
  MdSend,
  MdSettings,
} from 'react-icons/md';

import PageHeader from '../../components/ui/PageHeader';
import WalletScreen from '../../components/ui/WalletScreen';
import type { RootState } from '../../state/store';
import { selectNostrRelays } from '../../state/slices/experimentalSlice';
import { useI18n } from '../../i18n/useI18n';
import {
  myIdentity,
  sendDirectMessage,
  subscribeMessages,
  fetchProfile,
  publishMyProfile,
  publishKind10050,
  loadStoredMessages,
  storeMessages,
  toPubkeyHex,
  type ChatMessage,
  type NostrProfile,
} from '../../platform/desktop/nostr/chat';
import { copyToClipboard } from '../../utils/clipboard';

const short = (s: string) =>
  s.length > 16 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;

/** Merge two message lists by id, sorted by time. */
const mergeById = (a: ChatMessage[], b: ChatMessage[]): ChatMessage[] => {
  const seen = new Set(a.map((m) => m.id));
  return [...a, ...b.filter((m) => !seen.has(m.id))].sort(
    (x, y) => x.at - y.at
  );
};

const Avatar: React.FC<{ url?: string; fallback: string; size?: number }> = ({
  url,
  fallback,
  size = 44,
}) => (
  <div
    className="grid shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--wallet-border)] bg-[var(--wallet-accent)]/15 text-xs font-bold text-[var(--wallet-accent)]"
    style={{ height: size, width: size }}
  >
    {url ? (
      <img src={url} alt="" className="h-full w-full object-cover" />
    ) : (
      fallback.slice(0, 2).toUpperCase()
    )}
  </div>
);

/** Read a device image and downscale to a small square JPEG data URL, so the
 *  kind-0 profile stays small enough for relays to accept. */
function fileToAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read image'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('unsupported image'));
      img.onload = () => {
        const S = 128;
        const canvas = document.createElement('canvas');
        canvas.width = S;
        canvas.height = S;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('canvas unavailable'));
        const scale = Math.max(S / img.width, S / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = typeof reader.result === 'string' ? reader.result : '';
    };
    reader.readAsDataURL(file);
  });
}

const NostrChat: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const walletId = useSelector((s: RootState) => s.wallet_id.currentWalletId);
  const relays = useSelector(selectNostrRelays);

  const [me, setMe] = useState<{ pubkey: string; npub: string } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activePeer, setActivePeer] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Record<string, NostrProfile>>({});
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [showNewChat, setShowNewChat] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Self-profile editor.
  const [showProfile, setShowProfile] = useState(false);
  const [myName, setMyName] = useState('');
  const [myPicture, setMyPicture] = useState('');
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (walletId <= 0) return;
    myIdentity(walletId)
      .then(async (id) => {
        setMe(id);
        void publishKind10050(walletId, relays);
        // Hydrate saved history (contacts survive restarts) + my own profile so
        // the name/picture I published are shown instead of an empty editor.
        const stored = await loadStoredMessages(id.pubkey);
        if (stored.length) setMessages((prev) => mergeById(prev, stored));
        const mine = await fetchProfile(id.pubkey, relays);
        if (mine.name) setMyName(mine.name);
        if (mine.picture) setMyPicture(mine.picture);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [walletId, relays]);

  // Persist history locally whenever it grows (best-effort).
  useEffect(() => {
    if (me && messages.length) void storeMessages(me.pubkey, messages);
  }, [me, messages]);

  // One subscription for all my DMs; the thread view filters to the open peer.
  useEffect(() => {
    if (walletId <= 0) return;
    return subscribeMessages(
      walletId,
      (m) =>
        setMessages((prev) => {
          if (prev.some((x) => x.id === m.id)) return prev;
          // Drop a self-copy that echoes an optimistic send we already show.
          if (
            m.mine &&
            prev.some(
              (x) =>
                x.mine &&
                x.text === m.text &&
                x.to.join() === m.to.join() &&
                Math.abs(x.at - m.at) < 300
            )
          ) {
            return prev;
          }
          return [...prev, m].sort((a, b) => a.at - b.at);
        }),
      relays
    );
  }, [walletId, relays]);

  // Conversations = messages grouped by the other party, newest first.
  const conversations = useMemo(() => {
    const map = new Map<string, { peer: string; last: ChatMessage | null }>();
    for (const m of messages) {
      const peer = m.mine ? m.to[0] ?? '' : m.from;
      if (!peer || peer === me?.pubkey) continue;
      const cur = map.get(peer);
      if (!cur || !cur.last || m.at > cur.last.at)
        map.set(peer, { peer, last: m });
    }
    if (activePeer && !map.has(activePeer))
      map.set(activePeer, { peer: activePeer, last: null });
    const list = [...map.values()].sort(
      (a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0)
    );
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) =>
      (profiles[c.peer]?.name ?? c.peer).toLowerCase().includes(q)
    );
  }, [messages, me, activePeer, query, profiles]);

  // Fetch each peer's profile (name + picture) once.
  useEffect(() => {
    for (const c of conversations) {
      if (profiles[c.peer]) continue;
      fetchProfile(c.peer, relays)
        .then((p) =>
          setProfiles((prev) =>
            prev[c.peer] ? prev : { ...prev, [c.peer]: p }
          )
        )
        .catch(() => {});
    }
  }, [conversations, relays, profiles]);

  const thread = useMemo(
    () =>
      activePeer
        ? messages.filter(
            (m) =>
              m.from === activePeer || (m.mine && m.to.includes(activePeer))
          )
        : [],
    [messages, activePeer]
  );
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread.length]);

  const openConversation = useCallback(async () => {
    setErr(null);
    try {
      const hex = toPubkeyHex(recipient);
      setActivePeer(hex);
      setShowNewChat(false);
      setRecipient('');
      if (!profiles[hex]) {
        const p = await fetchProfile(hex, relays);
        setProfiles((prev) => ({ ...prev, [hex]: p }));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [recipient, relays, profiles]);

  const send = useCallback(async () => {
    if (!activePeer || !draft.trim() || walletId <= 0 || !me) return;
    const text = draft.trim();
    setSending(true);
    setErr(null);
    try {
      await sendDirectMessage(walletId, activePeer, text, relays);
      // Show + persist my message immediately — don't wait for it to round-trip
      // through a relay (which may not even echo a self-copy back).
      const mine: ChatMessage = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        from: me.pubkey,
        to: [activePeer],
        text,
        at: Math.floor(Date.now() / 1000),
        mine: true,
      };
      setMessages((prev) => mergeById(prev, [mine]));
      setDraft('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [activePeer, draft, walletId, relays, me]);

  const onPickImage = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    fileToAvatarDataUrl(file)
      .then(setMyPicture)
      .catch((x) => setProfileMsg(x instanceof Error ? x.message : String(x)));
  }, []);

  const saveProfile = useCallback(async () => {
    setProfileMsg(null);
    try {
      await publishMyProfile(
        walletId,
        { name: myName || undefined, picture: myPicture || undefined },
        relays
      );
      setProfileMsg(t('chat.profilePublished'));
    } catch (e) {
      setProfileMsg(e instanceof Error ? e.message : String(e));
    }
  }, [walletId, myName, myPicture, relays, t]);

  const nameOf = (peer: string) => profiles[peer]?.name || short(peer);
  const showThread = activePeer !== null;

  return (
    <WalletScreen maxWidthClassName="max-w-5xl" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-3">
        <PageHeader title={t('chat.title')} compact />
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight wallet-text-strong">
              {t('chat.title')}
            </h1>
            <p className="text-xs wallet-muted">{t('chat.privateMessaging')}</p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/settings?panel=nostr')}
            className="flex items-center gap-2 rounded-xl border border-[var(--wallet-border)] px-3 py-2 text-xs font-semibold wallet-text-strong"
          >
            <MdSettings aria-hidden="true" />
            {t('chat.setup')}
          </button>
        </div>

        {/* My identity + profile (with device-picked avatar) */}
        {me && (
          <div className="rounded-xl border border-[var(--wallet-border)] wallet-surface px-3 py-2">
            <div className="flex items-center gap-2">
              <Avatar
                url={myPicture || undefined}
                fallback={myName || 'me'}
                size={36}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] wallet-muted">{t('chat.yourNpub')}</p>
                <p className="truncate font-mono text-[11px] wallet-text-strong">
                  {me.npub}
                </p>
              </div>
              <button
                onClick={() => void copyToClipboard(me.npub)}
                className="wallet-icon-btn"
                aria-label={t('chat.copyNpub')}
              >
                <MdContentCopy />
              </button>
              <button
                onClick={() => setShowProfile((v) => !v)}
                className="rounded-lg border border-[var(--wallet-border)] px-2 py-1 text-[10px] font-semibold wallet-text-strong"
              >
                {t('chat.profile')}
              </button>
            </div>
            {showProfile && (
              <div className="mt-2 space-y-1.5 border-t border-[var(--wallet-border)] pt-2">
                <input
                  value={myName}
                  onChange={(e) => setMyName(e.target.value)}
                  placeholder={t('chat.displayName')}
                  className="wallet-input w-full text-xs"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="flex items-center gap-1 rounded-lg border border-[var(--wallet-border)] px-2 py-1.5 text-[10px] font-semibold wallet-text-strong"
                  >
                    <MdImage aria-hidden="true" /> {t('chat.choosePhoto')}
                  </button>
                  {myPicture && (
                    <Avatar
                      url={myPicture}
                      fallback={myName || 'me'}
                      size={28}
                    />
                  )}
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    onChange={onPickImage}
                    className="hidden"
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={() => void saveProfile()}
                    className="wallet-btn-primary px-3 py-1 text-xs"
                  >
                    {t('chat.publishProfile')}
                  </button>
                  {profileMsg && (
                    <span className="text-[10px] wallet-muted">
                      {profileMsg}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {err && <p className="break-all text-[10px] text-red-400/90">{err}</p>}

        <div className="wallet-card grid min-h-0 flex-1 overflow-hidden md:grid-cols-[minmax(240px,0.38fr)_minmax(0,1fr)]">
          {/* Conversation list */}
          <aside
            className={`${showThread ? 'hidden md:flex' : 'flex'} min-h-0 flex-col border-r border-[var(--wallet-border)]`}
          >
            <div className="space-y-3 border-b border-[var(--wallet-border)] p-3">
              <div className="flex items-center gap-2">
                <label className="wallet-input flex min-w-0 flex-1 items-center gap-2 py-1.5">
                  <MdSearch
                    className="shrink-0 wallet-muted"
                    aria-hidden="true"
                  />
                  <span className="sr-only">
                    {t('chat.searchConversations')}
                  </span>
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('chat.searchConversations')}
                    className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:wallet-muted"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setShowNewChat((v) => !v)}
                  className="grid h-11 w-11 place-items-center rounded-xl border border-[var(--wallet-border)] text-[var(--wallet-accent)]"
                  aria-label={t('chat.newChat')}
                  title={t('chat.newChat')}
                >
                  <MdAdd className="text-xl" aria-hidden="true" />
                </button>
              </div>
              {showNewChat && (
                <div className="flex items-center gap-2">
                  <input
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    placeholder={t('chat.recipient')}
                    className="wallet-input min-w-0 flex-1 font-mono text-xs"
                    onKeyDown={(e) =>
                      e.key === 'Enter' && void openConversation()
                    }
                  />
                  <button
                    onClick={() => void openConversation()}
                    className="wallet-btn-primary px-3 py-2 text-xs"
                  >
                    {t('chat.open')}
                  </button>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {conversations.length === 0 ? (
                <div className="grid h-full place-items-center p-6 text-center">
                  <p className="text-xs wallet-muted">
                    {t('chat.noConversations')}
                  </p>
                </div>
              ) : (
                conversations.map((c) => (
                  <button
                    key={c.peer}
                    type="button"
                    onClick={() => setActivePeer(c.peer)}
                    className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                      activePeer === c.peer
                        ? 'border-[var(--wallet-accent)]/40 bg-[var(--wallet-accent)]/10'
                        : 'border-transparent hover:bg-[var(--wallet-surface)]'
                    }`}
                  >
                    <Avatar
                      url={profiles[c.peer]?.picture}
                      fallback={nameOf(c.peer)}
                    />
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold wallet-text-strong">
                        {nameOf(c.peer)}
                      </span>
                      <p className="truncate text-[11px] wallet-muted">
                        {c.last
                          ? `${c.last.mine ? t('chat.youPrefix') : ''}${c.last.text}`
                          : t('chat.newConversation')}
                      </p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </aside>

          {/* Thread */}
          <main
            className={`${showThread ? 'flex' : 'hidden md:flex'} min-h-0 flex-col`}
          >
            {activePeer ? (
              <section className="flex h-full min-h-0 flex-col">
                <header className="flex items-center gap-3 border-b border-[var(--wallet-border)] px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setActivePeer(null)}
                    className="rounded-full p-2 wallet-surface-strong wallet-text-strong md:hidden"
                    aria-label={t('chat.back')}
                  >
                    <MdArrowBack aria-hidden="true" />
                  </button>
                  <Avatar
                    url={profiles[activePeer]?.picture}
                    fallback={nameOf(activePeer)}
                    size={40}
                  />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-bold wallet-text-strong">
                      {nameOf(activePeer)}
                    </h2>
                    <p className="truncate text-[11px] wallet-muted">
                      {profiles[activePeer]?.nip05 ?? t('chat.encrypted')}
                    </p>
                  </div>
                </header>

                <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-4">
                  {thread.length === 0 ? (
                    <p className="pt-6 text-center text-[10px] wallet-muted">
                      {t('chat.noMessages')}
                    </p>
                  ) : (
                    thread.map((m) => (
                      <div
                        key={m.id}
                        className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[80%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                            m.mine
                              ? 'rounded-tr-md border border-[var(--wallet-accent)]/30 bg-[var(--wallet-accent)]/10 wallet-text-strong'
                              : 'rounded-tl-md border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] wallet-text-strong'
                          }`}
                        >
                          {m.text}
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={bottomRef} />
                </div>

                <footer className="flex items-center gap-2 border-t border-[var(--wallet-border)] p-3">
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={t('chat.messagePlaceholder')}
                    className="wallet-input min-w-0 flex-1 text-xs"
                    onKeyDown={(e) => e.key === 'Enter' && void send()}
                    disabled={sending}
                  />
                  <button
                    onClick={() => void send()}
                    disabled={sending || !draft.trim()}
                    className="wallet-btn-primary grid h-10 w-10 place-items-center disabled:opacity-50"
                    aria-label={t('chat.send')}
                  >
                    <MdSend />
                  </button>
                </footer>
              </section>
            ) : (
              <div className="grid h-full place-items-center p-8 text-center">
                <div className="max-w-xs">
                  <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[var(--wallet-accent)]/15 text-[var(--wallet-accent)]">
                    <MdChatBubbleOutline
                      className="text-3xl"
                      aria-hidden="true"
                    />
                  </div>
                  <h2 className="mt-4 text-base font-bold wallet-text-strong">
                    {t('chat.privateConversations')}
                  </h2>
                  <p className="mt-2 text-xs leading-relaxed wallet-muted">
                    {t('chat.emptyDescription')}
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
