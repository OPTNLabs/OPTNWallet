// MDK, the Marmot Development Kit, runs in the Rust host (crates/optn-chat,
// src-tauri/src/chat_mdk.rs); this is its binding. Groups it holds reach the
// chat as MlsGroupRecords with engine 'mdk', handled through mlsEngine.ts
// beside ts-mls's own. docs/chat-mdk.md says what each engine speaks.
//
// The host keeps MDK's state in its own encrypted store and reaches relays
// under the holder's egress. This side only passes the chat identity over
// once and turns what comes back into the chat's shapes.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { bytesToHex } from '@noble/hashes/utils';
import type { ChatMessage } from './chat';
import type { MlsGroupRecord } from './mls';
import {
  deriveNostrIdentityFromSeed,
  loadNostrAccountSeed,
  wipeNostrIdentity,
} from './identity';

/** MDK groups' handle and room id: the MLS group id behind this prefix, so
 *  it can never be taken for a ts-mls group's. */
export const MDK_PREFIX = 'mdk:';
export const MDK_KIND_CHAT = 9;
export const MDK_KIND_FILE = 15;

export type MdkGroupView = {
  mlsGroupId: string;
  nostrGroupId: string;
  name: string;
  description: string;
  admins: string[];
  members: string[];
  relays: string[];
  active: boolean;
  epoch: number;
};

export type MdkMessage = {
  id: string;
  mlsGroupId: string;
  from: string;
  kind: number;
  content: string;
  tags: string[][];
  at: number;
  mine: boolean;
};

export type MdkEvent =
  | ({ type: 'message' } & MdkMessage)
  | ({ type: 'joined' } & MdkGroupView)
  | ({ type: 'changed' } & MdkGroupView);

let available: Promise<boolean> | null = null;

/** Whether this desktop build carries the MDK engine. */
export function mdkAvailable(): Promise<boolean> {
  available ??= invoke<boolean>('chat_mdk_available').catch(() => false);
  return available;
}

export const isMdkHandle = (handle: string | null | undefined): boolean =>
  !!handle && handle.startsWith(MDK_PREFIX);

const handleOf = (mlsGroupId: string) => `${MDK_PREFIX}${mlsGroupId}`;
const groupOf = (handle: string) => handle.slice(MDK_PREFIX.length);

export function mdkGroupRecord(
  view: MdkGroupView,
  owner: string
): MlsGroupRecord {
  const handle = handleOf(view.mlsGroupId);
  return {
    nostrGroupIdHex: handle,
    mlsGroupIdHex: view.mlsGroupId,
    roomId: handle,
    wire: 'nip-ee',
    // Every MDK group is read from relays, as ts-mls's open groups are.
    visibility: 'open',
    name: view.name || 'Marmot group',
    paytacaDual: false,
    memberPubKeys: view.members,
    ownerPubKey: owner,
    adminPubKeys: view.admins,
    engine: 'mdk',
  };
}

export function mdkChatMessage(message: MdkMessage): ChatMessage {
  const fileName = message.tags.find((tag) => tag[0] === 'filename')?.[1];
  return {
    id: message.id,
    from: message.from,
    to: [],
    text: message.content,
    at: message.at,
    mine: message.mine,
    kind: message.kind,
    roomId: handleOf(message.mlsGroupId),
    ...(fileName ? { fileName } : {}),
  };
}

type Session = { owner: string; groups: Map<string, MlsGroupRecord> };
let session: Session | null = null;

/** The MDK groups of the open identity, or none. */
export function mdkGroups(owner?: string): MlsGroupRecord[] {
  if (!session || (owner && owner !== session.owner)) return [];
  return [...session.groups.values()].filter((record) =>
    // A group this identity left or was removed from is no longer a chat.
    record.memberPubKeys.includes(session!.owner)
  );
}

function remember(view: MdkGroupView) {
  if (!session) return;
  const record = mdkGroupRecord(view, session.owner);
  if (view.active) session.groups.set(record.nostrGroupIdHex, record);
  else session.groups.delete(record.nostrGroupIdHex);
}

const call = <T>(op: string, args?: Record<string, unknown>) =>
  invoke<T>('chat_mdk_call', { op, args: args ?? null });

export type MdkHandlers = {
  onMessage: (message: ChatMessage) => void;
  /** The group list changed: joined, renamed, members, left. */
  onGroups?: () => void;
  onError?: (error: unknown) => void;
};

/** Open `walletId`'s chat identity in the MDK engine and read it: stored
 *  history first, then what relays hold, then live. Returns the closer. */
export async function openMdkChat(
  walletId: number,
  relays: string[],
  handlers: MdkHandlers
): Promise<() => void> {
  let closed = false;
  // Listen first: the host starts catching up as soon as it opens.
  const unlisten = await listen<MdkEvent>('chat-mdk://event', (event) => {
    if (closed) return;
    const payload = event.payload;
    if (payload.type === 'message') {
      handlers.onMessage(mdkChatMessage(payload));
      return;
    }
    remember(payload);
    handlers.onGroups?.();
  });

  const identity = await deriveNostrIdentityFromSeed(
    await loadNostrAccountSeed(walletId)
  );
  try {
    const opened = await invoke<{ publicKey: string; groups: MdkGroupView[] }>(
      'chat_mdk_open',
      { identity: bytesToHex(identity.secretKey), relays }
    );
    session = { owner: opened.publicKey, groups: new Map() };
    for (const view of opened.groups) remember(view);
    handlers.onGroups?.();
    for (const record of mdkGroups()) {
      const history = await call<MdkMessage[]>('messages', {
        group: record.mlsGroupIdHex,
        limit: 200,
      });
      for (const message of history)
        handlers.onMessage(mdkChatMessage(message));
    }
  } catch (error) {
    unlisten();
    throw error;
  } finally {
    wipeNostrIdentity(identity);
  }

  return () => {
    closed = true;
    unlisten();
    session = null;
    void invoke('chat_mdk_close').catch(() => {});
  };
}

export const mdkIsOpen = () => session !== null;

export async function createMdkGroup(
  name: string,
  members: string[],
  relays: string[]
): Promise<MlsGroupRecord> {
  const view = await call<MdkGroupView>('createGroup', {
    name,
    members,
    relays,
  });
  remember(view);
  return mdkGroupRecord(view, session?.owner ?? '');
}

export async function addMdkMembers(handle: string, members: string[]) {
  remember(
    await call<MdkGroupView>('addMembers', { group: groupOf(handle), members })
  );
}

export async function removeMdkMembers(handle: string, members: string[]) {
  remember(
    await call<MdkGroupView>('removeMembers', {
      group: groupOf(handle),
      members,
    })
  );
}

export async function renameMdkGroup(handle: string, name: string) {
  remember(
    await call<MdkGroupView>('rename', { group: groupOf(handle), name })
  );
}

export async function leaveMdkGroup(handle: string) {
  await call('leave', { group: groupOf(handle) });
  session?.groups.delete(handle);
}

export async function forgetMdkGroup(handle: string) {
  await call('forget', { group: groupOf(handle) });
  session?.groups.delete(handle);
}

export async function sendMdk(
  handle: string,
  kind: number,
  content: string,
  tags: string[][] = []
): Promise<{ id: string; at: number }> {
  const sent = await call<MdkMessage>('send', {
    group: groupOf(handle),
    kind,
    content,
    tags,
  });
  return { id: sent.id, at: sent.at };
}

/** Read relays since the last read; what is new arrives as events. */
export async function catchUpMdk(): Promise<void> {
  if (session) await call('catchUp');
}
