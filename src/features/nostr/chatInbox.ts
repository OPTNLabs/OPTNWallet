import { isInlineChatMedia, type ChatMessage } from '../../platform/desktop/nostr/chat';
import type { MlsGroupRecord } from '../../platform/desktop/nostr/mls';

export type ChatInboxKind = 'dm' | 'private-group' | 'open-group';

export type ChatInboxItem = {
  id: string;
  kind: ChatInboxKind;
  last: ChatMessage | null;
};

export function isInboxMessage(message: ChatMessage): boolean {
  return (message.kind ?? 14) === 14 || message.kind === 15 || isInlineChatMedia(message.text);
}

export function groupRecordForPeer(
  peer: string,
  groups: readonly MlsGroupRecord[]
): MlsGroupRecord | undefined {
  return groups.find(
    (group) => group.roomId === peer || group.nostrGroupIdHex === peer
  );
}

export function classifyChatPeer(
  peer: string,
  groups: readonly MlsGroupRecord[]
): ChatInboxKind {
  const record = groupRecordForPeer(peer, groups);
  if (record?.visibility === 'private') return 'private-group';
  if (record?.visibility === 'open') return 'open-group';
  return 'dm';
}

export function buildChatInbox(params: {
  messages: readonly ChatMessage[];
  groups: readonly MlsGroupRecord[];
  mePubKey?: string;
  activePeer: string | null;
  query: string;
  names?: Record<string, string | undefined>;
}): Record<ChatInboxKind, ChatInboxItem[]> {
  const map = new Map<string, ChatInboxItem>();

  const put = (id: string, kind: ChatInboxKind, last: ChatMessage | null) => {
    const existing = map.get(id);
    if (!existing) {
      map.set(id, { id, kind, last });
      return;
    }
    const newerLast =
      last && (!existing.last || last.at > existing.last.at) ? last : existing.last;
    const nextKind = existing.kind === 'dm' && kind !== 'dm' ? kind : existing.kind;
    map.set(id, { id, kind: nextKind, last: newerLast });
  };

  for (const group of params.groups) {
    put(
      group.roomId,
      group.visibility === 'private' ? 'private-group' : 'open-group',
      null
    );
  }

  for (const message of params.messages) {
    if (!isInboxMessage(message)) continue;
    const peer =
      message.roomId || (message.mine ? message.to[0] ?? '' : message.from);
    if (!peer || peer === params.mePubKey) continue;
    put(peer, classifyChatPeer(peer, params.groups), message);
  }

  if (params.activePeer && !map.has(params.activePeer)) {
    put(
      params.activePeer,
      classifyChatPeer(params.activePeer, params.groups),
      null
    );
  }

  const query = params.query.trim().toLowerCase();
  const items = [...map.values()].sort(
    (a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0)
  );
  const filtered = query
    ? items.filter((item) => {
        const name = params.names?.[item.id] ?? item.id;
        return name.toLowerCase().includes(query);
      })
    : items;

  return {
    dm: filtered.filter((item) => item.kind === 'dm'),
    'private-group': filtered.filter((item) => item.kind === 'private-group'),
    'open-group': filtered.filter((item) => item.kind === 'open-group'),
  };
}
