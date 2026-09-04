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
  MdAttachFile,
  MdImage,
  MdMic,
  MdRefresh,
  MdSearch,
  MdSend,
  MdSettings,
  MdStop,
} from 'react-icons/md';

import WalletScreen from '../../components/ui/WalletScreen';
import type { RootState } from '../../state/store';
import { selectNostrRelays } from '../../state/slices/experimentalSlice';
import { useI18n } from '../../i18n/useI18n';
import {
  myIdentity,
  sendDirectMessage,
  sendDirectFile,
  sendReaction,
  sendReadReceipt,
  subscribeMessages,
  fetchProfile,
  fetchPublishedAvatar,
  fetchPublishedDisplayName,
  fetchPublishedBchAddress,
  inlineChatLabel,
  isInlineChatMedia,
  MAX_INLINE_CHAT_DATA_URL,
  inlineChatTooLargeMessage,
  parseInlineChatFile,
  refetchChatInbox,
  publishKind10050,
  loadStoredMessages,
  storeMessages,
  loadLastRead,
  storeLastRead,
  toPubkeyHex,
  parseChatTip,
  encodeChatTip,
  type ChatMessage,
  type NostrProfile,
} from '../../platform/desktop/nostr/chat';

import {
  addMlsMember,
  createMlsGroup,
  forgetMlsGroup,
  isMlsAdmin,
  leaveMlsGroup,
  linkOwnDevice,
  listMlsGroups,
  loadMlsDeviceIndex,
  loadMlsIndex,
  publishMlsKeyPackage,
  refetchMlsInbox,
  removeMlsMember,
  renameMlsGroup,
  sendMlsFile,
  sendMlsMessage,
  subscribeMls,
  type MlsGroupRecord,
} from '../../platform/desktop/nostr/mls';
import {
  buildChatInbox,
  classifyChatPeer,
  groupRecordForPeer,
  type ChatInboxKind,
} from './chatInbox';
import { useWalletConfirm } from '../../components/WalletConfirmDialog';

const short = (s: string) =>
  s.length > 16 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;

/** Merge two message lists by id, sorted by time. */
const mergeById = (a: ChatMessage[], b: ChatMessage[]): ChatMessage[] => {
  const seen = new Set(a.map((m) => m.id));
  return [...a, ...b.filter((m) => !seen.has(m.id))].sort(
    (x, y) => x.at - y.at
  );
};

const isChatText = (m: ChatMessage) =>
  (m.kind ?? 14) === 14 || m.kind === 15 || isInlineChatMedia(m.text);

const relativeTime = (at: number): string => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const REACTION_EMOJIS = ['👍', '❤️', '😂', '🔥'] as const;

const Avatar: React.FC<{ url?: string; fallback: string; size?: number }> = ({
  url,
  fallback,
  size = 52,
}) => (
  <div
    className="grid shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--wallet-border)] bg-[var(--wallet-accent)]/15 text-xs font-bold text-[var(--wallet-accent)]"
    style={{ height: size, width: size }}
  >
    {url && !/^https?:/i.test(url) ? (
      <img src={url} alt="" className="h-full w-full object-cover" />
    ) : (
      fallback.slice(0, 2).toUpperCase()
    )}
  </div>
);

/** Read a device image and downscale to a small square JPEG data URL, so the
 *  kind-0 profile stays small enough for relays to accept. */
function fileToJpegDataUrl(
  file: File,
  size: number,
  quality: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read image'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('unsupported image'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, size / Math.max(img.width, img.height));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('canvas unavailable'));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.length > MAX_INLINE_CHAT_DATA_URL) {
          return reject(new Error(inlineChatTooLargeMessage('image/jpeg')));
        }
        resolve(dataUrl);
      };
      img.src = typeof reader.result === 'string' ? reader.result : '';
    };
    reader.readAsDataURL(file);
  });
}

function fileToChatPhotoDataUrl(file: File): Promise<string> {
  return fileToJpegDataUrl(file, 512, 0.72);
}

function fileToInlineDataUrl(file: File): Promise<string> {
  const tooBig = inlineChatTooLargeMessage(file.type, file.name);
  if (file.size > 72_000) {
    return Promise.reject(new Error(tooBig));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read file'));
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (
        !dataUrl.startsWith('data:') ||
        dataUrl.length > MAX_INLINE_CHAT_DATA_URL
      ) {
        reject(new Error(tooBig));
        return;
      }
      resolve(dataUrl);
    };
    reader.readAsDataURL(file);
  });
}

function downloadInlineFile(dataUrl: string, name: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  a.rel = 'noopener';
  a.click();
}

const NostrChat: React.FC = () => {
  const navigate = useNavigate();
  const confirm = useWalletConfirm();
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

  const [lastRead, setLastRead] = useState<Record<string, number>>({});
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editOf, setEditOf] = useState<ChatMessage | null>(null);
  const [activeMembers, setActiveMembers] = useState<string[] | null>(null);
  const [mlsGroupId, setMlsGroupId] = useState<string | null>(null);
  const [inviteDraft, setInviteDraft] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [showGroupPanel, setShowGroupPanel] = useState(false);
  const [mlsDeviceIndex, setMlsDeviceIndex] = useState(0);
  const [groupName, setGroupName] = useState('');
  const [mlsGroups, setMlsGroups] = useState<MlsGroupRecord[]>([]);
  const [composeKind, setComposeKind] = useState<ChatInboxKind>('dm');
  const [showTip, setShowTip] = useState(false);
  const [tipAmount, setTipAmount] = useState('');
  const [tipCategory, setTipCategory] = useState('');
  const [refetching, setRefetching] = useState(false);
  const [recording, setRecording] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const chatPhotoRef = useRef<HTMLInputElement>(null);
  const chatFileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (walletId <= 0) return;
    myIdentity(walletId)
      .then(async (id) => {
        setMe(id);
        void publishKind10050(walletId, relays);
        const slot = await loadMlsDeviceIndex(id.pubkey);
        setMlsDeviceIndex(slot);
        const groups = await loadMlsIndex(id.pubkey);
        setMlsGroups(groups);
        void publishMlsKeyPackage(walletId, relays);
        // Hydrate saved history (contacts survive restarts) + my own profile so
        // the name/picture I published are shown instead of an empty editor.
        const stored = await loadStoredMessages(id.pubkey);
        if (stored.length) setMessages((prev) => mergeById(prev, stored));
        const read = await loadLastRead(id.pubkey);
        setLastRead(read);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [walletId, relays]);

  // Persist history locally whenever it grows (best-effort).
  useEffect(() => {
    if (me && messages.length) void storeMessages(me.pubkey, messages);
  }, [me, messages]);

  useEffect(() => {
    if (me) void storeLastRead(me.pubkey, lastRead);
  }, [me, lastRead]);

  // NIP-17 DMs (1059) plus NIP-EE MLS (444/445) and Paytaca 30078 MLS.
  useEffect(() => {
    if (walletId <= 0) return;
    const onMessage = (m: ChatMessage) =>
      setMessages((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev;
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
      });
    const unsubDm = subscribeMessages(walletId, onMessage, relays);
    const unsubMls = subscribeMls(walletId, onMessage, relays);
    return () => {
      unsubDm();
      unsubMls();
    };
  }, [walletId, relays]);

  const inbox = useMemo(
    () =>
      buildChatInbox({
        messages,
        groups: mlsGroups,
        mePubKey: me?.pubkey,
        activePeer,
        query,
        names: Object.fromEntries(
          Object.entries(profiles).map(([peer, profile]) => [peer, profile.name])
        ),
      }),
    [messages, mlsGroups, me, activePeer, query, profiles]
  );
  const conversations = useMemo(
    () => [...inbox.dm, ...inbox['private-group'], ...inbox['open-group']],
    [inbox]
  );

  // Fetch each peer's profile (name + picture) once.
  useEffect(() => {
    for (const c of conversations) {
      if (c.kind !== 'dm' || profiles[c.id]) continue;
      Promise.all([
        fetchProfile(c.id, relays),
        fetchPublishedAvatar(relays, c.id),
        fetchPublishedDisplayName(relays, c.id),
      ])
        .then(([p, avatar, displayName]) =>
          setProfiles((prev) =>
            prev[c.id]
              ? prev
              : {
                  ...prev,
                  [c.id]: {
                    ...p,
                    name: displayName || p.name,
                    picture: avatar || p.picture,
                  },
                }
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
              isChatText(m) &&
              (m.roomId === activePeer ||
                m.from === activePeer ||
                (m.mine && m.to.includes(activePeer)))
          )
        : [],
    [messages, activePeer]
  );
  const reactionsByTarget = useMemo(() => {
    const map = new Map<string, ChatMessage[]>();
    for (const m of messages) {
      if ((m.kind ?? 14) !== 7 || m.isReadReceipt) continue;
      for (const target of m.targetIds ?? []) {
        const list = map.get(target) ?? [];
        list.push(m);
        map.set(target, list);
      }
    }
    return map;
  }, [messages]);
  const deletedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of messages) {
      if ((m.kind ?? 14) === 5) {
        for (const target of m.targetIds ?? []) ids.add(target);
      }
    }
    return ids;
  }, [messages]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread.length]);

  useEffect(() => {
    if (!activePeer || !me || walletId <= 0) return;
    const previouslyRead = lastRead[activePeer];
    const unread = previouslyRead
      ? thread.filter((m) => !m.mine && m.at > previouslyRead)
      : [];
    setLastRead((prev) => ({
      ...prev,
      [activePeer]: Math.floor(Date.now() / 1000),
    }));
    if (unread.length) {
      void sendReadReceipt(
        walletId,
        activePeer,
        unread.map((m) => m.id),
        relays
      );
    }
    // Marking read is intentional on open; lastRead is updated after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePeer]);

  const openConversation = useCallback(async () => {
    setErr(null);
    try {
      if (composeKind === 'open-group') {
        if (!me || walletId <= 0) return;
        const created = await createMlsGroup(
          walletId,
          groupName.trim() || 'Open MLS group',
          me.pubkey,
          { visibility: 'open', relays }
        );
        setMlsGroups(listMlsGroups(me.pubkey));
        setActivePeer(created.roomId);
        setActiveMembers([me.pubkey]);
        setMlsGroupId(created.nostrGroupIdHex);
        setShowNewChat(false);
        setGroupName('');
        return;
      }
      const parts = recipient
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if ((composeKind === 'private-group' || parts.length > 1) && me) {
        const hexes = parts.map(toPubkeyHex);
        const members = Array.from(new Set([me.pubkey, ...hexes]));
        const created = await createMlsGroup(
          walletId,
          groupName.trim() || 'Private group',
          me.pubkey,
          { visibility: 'private', relays }
        );
        setMlsGroups(listMlsGroups(me.pubkey));
        setActivePeer(created.roomId);
        setActiveMembers(members);
        setMlsGroupId(created.nostrGroupIdHex);
        const inviteErrors: string[] = [];
        for (const hex of hexes) {
          try {
            await addMlsMember(walletId, created.nostrGroupIdHex, hex, relays);
          } catch (e) {
            inviteErrors.push(
              `${hex.slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
        if (inviteErrors.length) setErr(inviteErrors.join(' '));
        setShowNewChat(false);
        setRecipient('');
        return;
      }
      const hex = toPubkeyHex(recipient);
      setActivePeer(hex);
      setActiveMembers(null);
      setMlsGroupId(null);
      setShowNewChat(false);
      setRecipient('');
      if (!profiles[hex]) {
        const [p, avatar, displayName] = await Promise.all([
          fetchProfile(hex, relays),
          fetchPublishedAvatar(relays, hex),
          fetchPublishedDisplayName(relays, hex),
        ]);
        setProfiles((prev) => ({
          ...prev,
          [hex]: {
            ...p,
            name: displayName || p.name,
            picture: avatar || p.picture,
          },
        }));
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setErr(
        raw === 'invalid pubkey' || raw.includes('npub or 64-character')
          ? t('chat.invalidPubkey')
          : raw
      );
    }
  }, [composeKind, recipient, relays, profiles, me, groupName, walletId, t]);

  const send = useCallback(async () => {
    if (!activePeer || !draft.trim() || walletId <= 0 || !me) return;
    const text = draft.trim();
    setSending(true);
    setErr(null);
    try {
      const extra = {
        replyTo: replyTo?.id,
        editOf: editOf?.id,
      };
      if (mlsGroupId) {
        await sendMlsMessage(walletId, mlsGroupId, activePeer, text, relays);
      } else {
        await sendDirectMessage(walletId, activePeer, text, relays, extra);
      }
      // Show + persist my message immediately — don't wait for it to round-trip
      // through a relay (which may not even echo a self-copy back).
      const mine: ChatMessage = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        from: me.pubkey,
        to: activeMembers ?? [activePeer],
        text,
        at: Math.floor(Date.now() / 1000),
        mine: true,
        replyTo: extra.replyTo,
        editOf: extra.editOf,
        roomId: mlsGroupId ? activePeer : undefined,
      };
      setMessages((prev) => mergeById(prev, [mine]));
      setDraft('');
      setReplyTo(null);
      setEditOf(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [
    activePeer,
    draft,
    walletId,
    relays,
    me,
    replyTo,
    editOf,
    mlsGroupId,
    activeMembers,
  ]);

  const refetchHistory = useCallback(async () => {
    if (walletId <= 0) return;
    setRefetching(true);
    setErr(null);
    try {
      const onMessage = (m: ChatMessage) =>
        setMessages((prev) => mergeById(prev, [m]));
      await refetchChatInbox(walletId, onMessage, relays);
      await refetchMlsInbox(walletId, onMessage, relays);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRefetching(false);
    }
  }, [walletId, relays]);

  const sendChatFile = useCallback(
    async (file: File) => {
      if (!activePeer || walletId <= 0 || !me) return;
      setSending(true);
      setErr(null);
      try {
        const dataUrl = file.type.startsWith('image/')
          ? await fileToChatPhotoDataUrl(file)
          : await fileToInlineDataUrl(file);
        const parsed = parseInlineChatFile(dataUrl);
        const extra = {
          replyTo: replyTo?.id,
          fileName: file.name,
          mimeType: parsed?.mime || file.type || 'application/octet-stream',
        };
        if (mlsGroupId) {
          await sendMlsFile(
            walletId,
            mlsGroupId,
            activePeer,
            dataUrl,
            relays,
            extra
          );
        } else {
          await sendDirectFile(walletId, activePeer, dataUrl, relays, extra);
        }
        const mine: ChatMessage = {
          id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          from: me.pubkey,
          to: activeMembers ?? [activePeer],
          text: dataUrl,
          at: Math.floor(Date.now() / 1000),
          mine: true,
          kind: 15,
          replyTo: replyTo?.id,
          roomId: mlsGroupId ? activePeer : undefined,
          fileName: file.name,
        };
        setMessages((prev) => mergeById(prev, [mine]));
        setReplyTo(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setSending(false);
      }
    },
    [activePeer, walletId, me, mlsGroupId, relays, replyTo, activeMembers]
  );

  const stopVoice = useCallback(() => {
    if (recordTimerRef.current) {
      clearTimeout(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    const rec = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const startVoice = useCallback(async () => {
    if (!activePeer || recording) return;
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      // ~16 kbit/s × 20s ≈ 40KB before base64 — usually under the wrap cap.
      const rec = new MediaRecorder(stream, {
        mimeType: mime,
        audioBitsPerSecond: 16_000,
      });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        const file = new File([blob], 'voice.webm', {
          type: blob.type || 'audio/webm',
        });
        void sendChatFile(file);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      recordTimerRef.current = setTimeout(() => stopVoice(), 20_000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Microphone unavailable');
    }
  }, [activePeer, recording, sendChatFile, stopVoice]);

  const nameOf = (peer: string) =>
    groupRecordForPeer(peer, mlsGroups)?.name ||
    profiles[peer]?.name ||
    short(peer);
  const kindOf = (peer: string): ChatInboxKind =>
    classifyChatPeer(peer, mlsGroups);
  const openInboxItem = (peer: string) => {
    setActivePeer(peer);
    const record = groupRecordForPeer(peer, mlsGroups);
    setMlsGroupId(record?.nostrGroupIdHex ?? null);
    setActiveMembers(record?.memberPubKeys ?? null);
  };
  const unreadOf = (peer: string) =>
    messages.filter(
      (m) =>
        isChatText(m) &&
        !m.mine &&
        (m.roomId === peer || (!m.roomId && m.from === peer)) &&
        m.at > (lastRead[peer] ?? 0)
    ).length;
  const reactTo = async (m: ChatMessage, emoji: string) => {
    if (!activePeer || walletId <= 0) return;
    try {
      await sendReaction(walletId, activePeer, m.id, m.from, emoji, relays);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const showThread = activePeer !== null;

  return (
    <WalletScreen maxWidthClassName="max-w-5xl" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight wallet-text-strong">
              {t('chat.title')}
            </h1>
            <p className="text-xs wallet-muted">{t('chat.privateMessaging')}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refetchHistory()}
              disabled={refetching || walletId <= 0}
              className="flex items-center gap-2 rounded-xl border border-[var(--wallet-border)] px-3 py-2 text-xs font-semibold wallet-text-strong disabled:opacity-50"
              title="Reload DMs and MLS backups from relays"
            >
              <MdRefresh aria-hidden="true" />
              {refetching ? '…' : 'Refetch'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/settings')}
              className="flex items-center gap-2 rounded-xl border border-[var(--wallet-border)] px-3 py-2 text-xs font-semibold wallet-text-strong"
            >
              <MdSettings aria-hidden="true" />
              {t('app.settings')}
            </button>
          </div>
        </div>

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
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-1">
                    {(
                      [
                        ['dm', t('chat.newPrivateChat')],
                        ['private-group', t('chat.newPrivateGroup')],
                        ['open-group', t('chat.newOpenMlsGroup')],
                      ] as const
                    ).map(([kind, label]) => (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => setComposeKind(kind)}
                        className={`rounded-lg border px-1.5 py-1.5 text-[10px] font-semibold ${
                          composeKind === kind
                            ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)]'
                            : 'border-[var(--wallet-border)] wallet-text-strong'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {composeKind !== 'open-group' && (
                    <input
                      value={recipient}
                      onChange={(e) => setRecipient(e.target.value)}
                      placeholder={
                        composeKind === 'private-group'
                          ? t('chat.privateGroupPlaceholder')
                          : t('chat.privateChatPlaceholder')
                      }
                      className="wallet-input w-full font-mono text-xs"
                      onKeyDown={(e) =>
                        e.key === 'Enter' && void openConversation()
                      }
                    />
                  )}
                  {composeKind !== 'dm' && (
                    <input
                      value={groupName}
                      onChange={(e) => setGroupName(e.target.value)}
                      placeholder={t('chat.groupNameOptional')}
                      className="wallet-input w-full text-xs"
                    />
                  )}
                  <button
                    onClick={() => void openConversation()}
                    className="wallet-btn-primary w-full px-3 py-2 text-xs"
                  >
                    {composeKind === 'dm'
                      ? t('chat.open')
                      : composeKind === 'private-group'
                        ? t('chat.createPrivateGroup')
                        : t('chat.createOpenGroup')}
                  </button>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
              {(
                [
                  ['dm', t('chat.privateChats'), t('chat.emptyPrivateChats')],
                  [
                    'private-group',
                    t('chat.privateGroups'),
                    t('chat.emptyPrivateGroups'),
                  ],
                  [
                    'open-group',
                    t('chat.openMlsGroups'),
                    t('chat.emptyOpenGroups'),
                  ],
                ] as const
              ).map(([kind, title, empty]) => (
                <section key={kind} className="space-y-1">
                  <h2 className="px-1 text-[10px] font-semibold uppercase tracking-wide wallet-muted">
                    {title}
                  </h2>
                  {inbox[kind].length === 0 ? (
                    <p className="px-1 py-2 text-[11px] wallet-muted">{empty}</p>
                  ) : (
                    inbox[kind].map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => openInboxItem(c.id)}
                        className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                          activePeer === c.id
                            ? 'border-[var(--wallet-accent)]/40 bg-[var(--wallet-accent)]/10'
                            : 'border-transparent hover:bg-[var(--wallet-surface)]'
                        }`}
                      >
                        <Avatar
                          url={profiles[c.id]?.picture}
                          fallback={nameOf(c.id)}
                          size={44}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="block truncate text-sm font-semibold wallet-text-strong">
                              {nameOf(c.id)}
                            </span>
                            {c.last && (
                              <span className="shrink-0 text-[10px] wallet-muted">
                                {relativeTime(c.last.at)}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-[11px] wallet-muted">
                              {c.last
                                ? `${c.last.mine ? t('chat.youPrefix') : ''}${
                                    isInlineChatMedia(c.last.text)
                                      ? inlineChatLabel(c.last.text)
                                      : c.last.text
                                  }`
                                : t('chat.newConversation')}
                            </p>
                            {unreadOf(c.id) > 0 && (
                              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[var(--wallet-accent)] px-1.5 text-[10px] font-bold text-white">
                                {unreadOf(c.id)}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </section>
              ))}
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
                      {kindOf(activePeer) === 'private-group'
                        ? t('chat.encryptedPrivateGroup')
                        : kindOf(activePeer) === 'open-group'
                          ? t('chat.encryptedOpenGroup')
                          : (profiles[activePeer]?.nip05 ?? t('chat.encrypted'))}
                    </p>
                  </div>
                  {mlsGroupId && (
                    <button
                      type="button"
                      className="shrink-0 rounded-lg border border-[var(--wallet-border)] px-2 py-1 text-[10px] font-semibold wallet-text-strong"
                      onClick={() => {
                        const record = groupRecordForPeer(activePeer, mlsGroups);
                        setRenameDraft(record?.name ?? '');
                        setShowGroupPanel((open) => !open);
                      }}
                    >
                      {t('chat.groupMembers')}
                    </button>
                  )}
                  {mlsGroupId && mlsDeviceIndex === 0 && (
                    <button
                      type="button"
                      className="shrink-0 rounded-lg border border-[var(--wallet-border)] px-2 py-1 text-[10px] font-semibold wallet-text-strong"
                      onClick={() => {
                        void (async () => {
                          const ok = await confirm(
                            'Add your extra device (slot 1) to this group as another MLS leaf?'
                          );
                          if (!ok) return;
                          try {
                            await linkOwnDevice(
                              walletId,
                              mlsGroupId,
                              1,
                              relays
                            );
                          } catch (e) {
                            setErr(e instanceof Error ? e.message : String(e));
                          }
                        })();
                      }}
                    >
                      Add extra device
                    </button>
                  )}
                </header>

                {showGroupPanel && mlsGroupId && me && (
                  <div className="space-y-2 border-b border-[var(--wallet-border)] px-4 py-3 text-xs">
                    {(() => {
                      const record = groupRecordForPeer(activePeer, mlsGroups);
                      const admin = record ? isMlsAdmin(record, me.pubkey) : false;
                      const members = record?.memberPubKeys ?? activeMembers ?? [];
                      return (
                        <>
                          {admin && (
                            <div className="flex gap-2">
                              <input
                                value={renameDraft}
                                onChange={(e) => setRenameDraft(e.target.value)}
                                className="wallet-input min-w-0 flex-1 text-xs"
                                placeholder={t('chat.groupNameOptional')}
                              />
                              <button
                                type="button"
                                className="rounded-lg border border-[var(--wallet-border)] px-2 py-1 font-semibold"
                                onClick={() => {
                                  void (async () => {
                                    try {
                                      await renameMlsGroup(
                                        walletId,
                                        mlsGroupId,
                                        renameDraft,
                                        relays
                                      );
                                      setMlsGroups(listMlsGroups(me.pubkey));
                                    } catch (e) {
                                      setErr(
                                        e instanceof Error ? e.message : String(e)
                                      );
                                    }
                                  })();
                                }}
                              >
                                {t('chat.renameGroup')}
                              </button>
                            </div>
                          )}
                          <p className="font-semibold wallet-text-strong">
                            {t('chat.groupMembers')}
                            {admin ? ` · ${t('chat.youAreAdmin')}` : ''}
                          </p>
                          <ul className="space-y-1">
                            {members.map((member) => (
                              <li
                                key={member}
                                className="flex items-center justify-between gap-2"
                              >
                                <span className="truncate font-mono">
                                  {member === me.pubkey
                                    ? `${t('chat.youPrefix').replace(': ', '')} (${short(member)})`
                                    : profiles[member]?.name || short(member)}
                                </span>
                                {admin && member !== me.pubkey && (
                                  <button
                                    type="button"
                                    className="shrink-0 text-[10px] font-semibold text-red-400"
                                    onClick={() => {
                                      void (async () => {
                                        const ok = await confirm(
                                          t('chat.kickMember')
                                        );
                                        if (!ok) return;
                                        try {
                                          await removeMlsMember(
                                            walletId,
                                            mlsGroupId,
                                            member,
                                            relays
                                          );
                                          setMlsGroups(listMlsGroups(me.pubkey));
                                          setActiveMembers(
                                            listMlsGroups(me.pubkey).find(
                                              (group) =>
                                                group.nostrGroupIdHex ===
                                                mlsGroupId
                                            )?.memberPubKeys ?? null
                                          );
                                        } catch (e) {
                                          setErr(
                                            e instanceof Error
                                              ? e.message
                                              : String(e)
                                          );
                                        }
                                      })();
                                    }}
                                  >
                                    {t('chat.kickMember')}
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                          {admin && (
                            <div className="flex gap-2">
                              <input
                                value={inviteDraft}
                                onChange={(e) => setInviteDraft(e.target.value)}
                                className="wallet-input min-w-0 flex-1 font-mono text-xs"
                                placeholder={t('chat.invitePlaceholder')}
                              />
                              <button
                                type="button"
                                className="rounded-lg border border-[var(--wallet-border)] px-2 py-1 font-semibold"
                                onClick={() => {
                                  void (async () => {
                                    try {
                                      const hex = toPubkeyHex(inviteDraft);
                                      await addMlsMember(
                                        walletId,
                                        mlsGroupId,
                                        hex,
                                        relays
                                      );
                                      setInviteDraft('');
                                      setMlsGroups(listMlsGroups(me.pubkey));
                                    } catch (e) {
                                      const raw =
                                        e instanceof Error
                                          ? e.message
                                          : String(e);
                                      setErr(
                                        raw.includes('npub') ||
                                          raw === 'invalid pubkey'
                                          ? t('chat.invalidPubkey')
                                          : raw
                                      );
                                    }
                                  })();
                                }}
                              >
                                {t('chat.inviteMember')}
                              </button>
                            </div>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="rounded-lg border border-[var(--wallet-border)] px-2 py-1 font-semibold"
                              onClick={() => {
                                void (async () => {
                                  const ok = await confirm(t('chat.leaveGroup'));
                                  if (!ok || !me) return;
                                  try {
                                    await leaveMlsGroup(
                                      walletId,
                                      mlsGroupId,
                                      relays
                                    );
                                    setMlsGroups(listMlsGroups(me.pubkey));
                                    setActivePeer(null);
                                    setMlsGroupId(null);
                                    setShowGroupPanel(false);
                                  } catch (e) {
                                    setErr(
                                      e instanceof Error ? e.message : String(e)
                                    );
                                  }
                                })();
                              }}
                            >
                              {t('chat.leaveGroup')}
                            </button>
                            {admin && (
                              <button
                                type="button"
                                className="rounded-lg border border-red-400/40 px-2 py-1 font-semibold text-red-400"
                                onClick={() => {
                                  void (async () => {
                                    const ok = await confirm(
                                      t('chat.deleteGroup')
                                    );
                                    if (!ok || !me) return;
                                    try {
                                      await leaveMlsGroup(
                                        walletId,
                                        mlsGroupId,
                                        relays
                                      );
                                      await forgetMlsGroup(
                                        mlsGroupId,
                                        me.pubkey
                                      );
                                      setMlsGroups(listMlsGroups(me.pubkey));
                                      setActivePeer(null);
                                      setMlsGroupId(null);
                                      setShowGroupPanel(false);
                                    } catch (e) {
                                      setErr(
                                        e instanceof Error
                                          ? e.message
                                          : String(e)
                                      );
                                    }
                                  })();
                                }}
                              >
                                {t('chat.deleteGroup')}
                              </button>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}

                <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-4">
                  {thread.length === 0 ? (
                    <p className="pt-6 text-center text-[10px] wallet-muted">
                      {t('chat.noMessages')}
                    </p>
                  ) : (
                    thread.map((m) => {
                      const gone = deletedIds.has(m.id);
                      const reactions = reactionsByTarget.get(m.id) ?? [];
                      return (
                        <div
                          key={m.id}
                          className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}
                        >
                          <div className="max-w-[80%] space-y-1">
                            <div
                              className={`rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                                m.mine
                                  ? 'rounded-tr-md border border-[var(--wallet-accent)]/30 bg-[var(--wallet-accent)]/10 wallet-text-strong'
                                  : 'rounded-tl-md border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] wallet-text-strong'
                              }`}
                            >
                              {gone ? (
                                <span className="italic wallet-muted">
                                  Deleted
                                </span>
                              ) : (
                                <>
                                  {m.replyTo && (
                                    <p className="mb-1 text-[10px] wallet-muted">
                                      Reply
                                    </p>
                                  )}
                                  {m.editOf && (
                                    <p className="mb-1 text-[10px] wallet-muted">
                                      Edited
                                    </p>
                                  )}
                                  {(() => {
                                    const inline = parseInlineChatFile(m.text);
                                    if (inline) {
                                      if (inline.mime.startsWith('image/')) {
                                        return (
                                          <img
                                            src={inline.dataUrl}
                                            alt=""
                                            className="max-h-48 max-w-full rounded-lg"
                                          />
                                        );
                                      }
                                      if (inline.mime.startsWith('audio/')) {
                                        return (
                                          <audio
                                            controls
                                            src={inline.dataUrl}
                                            className="w-56"
                                          />
                                        );
                                      }
                                      if (inline.mime.startsWith('video/')) {
                                        return (
                                          <video
                                            controls
                                            src={inline.dataUrl}
                                            className="max-h-48 max-w-full rounded-lg"
                                          />
                                        );
                                      }
                                      const name =
                                        m.fileName ||
                                        (inline.mime === 'application/pdf'
                                          ? 'file.pdf'
                                          : 'file');
                                      return (
                                        <button
                                          type="button"
                                          className="text-left text-[11px] underline"
                                          onClick={() =>
                                            downloadInlineFile(
                                              inline.dataUrl,
                                              name
                                            )
                                          }
                                        >
                                          {inline.mime === 'application/pdf'
                                            ? 'PDF — tap to save'
                                            : `${name} — tap to save`}
                                        </button>
                                      );
                                    }
                                    const tip = parseChatTip(m.text);
                                    if (!tip) return m.text;
                                    return (
                                      <div>
                                        <p className="font-semibold">
                                          Tip {tip.amount}{' '}
                                          {tip.asset === 'bch'
                                            ? 'BCH'
                                            : 'CashToken'}
                                        </p>
                                        {tip.category && (
                                          <p className="break-all font-mono text-[10px] wallet-muted">
                                            {tip.category}
                                          </p>
                                        )}
                                      </div>
                                    );
                                  })()}
                                </>
                              )}
                            </div>
                            {!gone && (
                              <div
                                className={`flex flex-wrap items-center gap-1 ${
                                  m.mine ? 'justify-end' : 'justify-start'
                                }`}
                              >
                                <button
                                  type="button"
                                  className="text-[10px] wallet-muted"
                                  onClick={() => {
                                    setReplyTo(m);
                                    setEditOf(null);
                                  }}
                                >
                                  Reply
                                </button>
                                {m.mine &&
                                  Math.floor(Date.now() / 1000) - m.at < 60 && (
                                    <button
                                      type="button"
                                      className="text-[10px] wallet-muted"
                                      onClick={() => {
                                        setEditOf(m);
                                        setReplyTo(null);
                                        setDraft(m.text);
                                      }}
                                    >
                                      Edit
                                    </button>
                                  )}
                                {reactions.map((r) => (
                                  <span
                                    key={r.id}
                                    className="rounded-full border border-[var(--wallet-border)] px-1.5 py-0.5 text-[11px]"
                                  >
                                    {r.emoji}
                                  </span>
                                ))}
                                {REACTION_EMOJIS.map((emoji) => (
                                  <button
                                    key={emoji}
                                    type="button"
                                    className="rounded-full px-1 text-[11px] opacity-50 hover:opacity-100"
                                    aria-label={emoji}
                                    onClick={() => void reactTo(m, emoji)}
                                  >
                                    {emoji}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={bottomRef} />
                </div>

                <footer className="space-y-2 border-t border-[var(--wallet-border)] p-3">
                  {(replyTo || editOf) && (
                    <div className="flex items-center justify-between text-[10px] wallet-muted">
                      <span>
                        {editOf ? 'Editing' : 'Replying'}:{' '}
                        {(editOf ?? replyTo)?.text.slice(0, 80)}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setReplyTo(null);
                          setEditOf(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {showTip && (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        value={tipAmount}
                        onChange={(e) => setTipAmount(e.target.value)}
                        placeholder="Amount"
                        className="wallet-input w-24 text-xs"
                      />
                      <input
                        value={tipCategory}
                        onChange={(e) => setTipCategory(e.target.value)}
                        placeholder="CashToken category (blank = BCH)"
                        className="wallet-input min-w-0 flex-1 font-mono text-[10px]"
                      />
                      <button
                        type="button"
                        className="wallet-btn-primary px-3 py-1 text-xs"
                        onClick={() => {
                          void (async () => {
                            if (!activePeer || !tipAmount.trim()) return;
                            const tip = tipCategory.trim()
                              ? {
                                  asset: 'ft' as const,
                                  amount: tipAmount.trim(),
                                  category: tipCategory.trim().toLowerCase(),
                                }
                              : {
                                  asset: 'bch' as const,
                                  amount: tipAmount.trim(),
                                };
                            const ok = await confirm(
                              `Send ${tip.amount} ${
                                tip.asset === 'bch' ? 'BCH' : 'CashToken'
                              }? This opens the send screen — chat cannot spend by itself.`
                            );
                            if (!ok) return;
                            const to =
                              (await fetchPublishedBchAddress(
                                relays,
                                activeMembers?.[1] ?? activePeer
                              )) || '';
                            navigate('/send', {
                              state: {
                                returnTo: '/chat',
                                recipient: to,
                                amountBch:
                                  tip.asset === 'bch' ? tip.amount : undefined,
                                amountToken:
                                  tip.asset === 'ft' ? tip.amount : undefined,
                                assetType: tip.asset,
                                selectedCategory: tip.category,
                              },
                            });
                            setDraft(encodeChatTip(tip));
                            setShowTip(false);
                          })();
                        }}
                      >
                        Confirm tip
                      </button>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-[var(--wallet-border)] px-2 py-2 text-[10px] font-semibold wallet-text-strong"
                      onClick={() => setShowTip((v) => !v)}
                    >
                      Tip
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-[var(--wallet-border)] px-2 py-2 text-[10px] font-semibold wallet-text-strong disabled:opacity-50"
                      disabled={sending || !activePeer}
                      onClick={() => chatPhotoRef.current?.click()}
                      title="Send photo in this chat (inside the wrap, no CDN)"
                      aria-label="Send photo"
                    >
                      <MdImage aria-hidden="true" />
                    </button>
                    <input
                      ref={chatPhotoRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void sendChatFile(file);
                      }}
                    />
                    <button
                      type="button"
                      className="rounded-lg border border-[var(--wallet-border)] px-2 py-2 text-[10px] font-semibold wallet-text-strong disabled:opacity-50"
                      disabled={sending || !activePeer}
                      onClick={() => chatFileRef.current?.click()}
                      title="Send PDF or file in this chat (inside the wrap, no CDN)"
                      aria-label="Send file"
                    >
                      <MdAttachFile aria-hidden="true" />
                    </button>
                    <input
                      ref={chatFileRef}
                      type="file"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void sendChatFile(file);
                      }}
                    />
                    <button
                      type="button"
                      className={`rounded-lg border px-2 py-2 text-[10px] font-semibold disabled:opacity-50 ${
                        recording
                          ? 'border-red-400 text-red-400'
                          : 'border-[var(--wallet-border)] wallet-text-strong'
                      }`}
                      disabled={sending || !activePeer}
                      onClick={() =>
                        recording ? stopVoice() : void startVoice()
                      }
                      title="Voice note, max 20s, inside the wrap (not NIP-A0 URL)"
                      aria-label={recording ? 'Stop recording' : 'Record voice'}
                    >
                      {recording ? (
                        <MdStop aria-hidden="true" />
                      ) : (
                        <MdMic aria-hidden="true" />
                      )}
                    </button>
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
                  </div>
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
