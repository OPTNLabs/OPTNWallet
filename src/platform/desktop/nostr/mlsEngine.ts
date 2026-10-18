// The chat's two MLS engines behind the calls the chat screen makes:
//
// - ts-mls (mls.ts): every group it made, private (gift-wrapped) groups,
//   Paytaca, extra-device leaves. Always on.
// - MDK (mdkChat.ts): Marmot through MDK in the Rust host, when this build has
//   it and the holder turned it on. New open groups go to it.
//
// A group stays with the engine that made it; each call goes to the group's
// engine by its handle. docs/chat-mdk.md lists what each engine speaks.

import type { ChatMessage } from './chat';
import { DEFAULT_RELAYS } from './defaultRelays';
import * as tsMls from './mls';
import type { MlsGroupRecord, MlsVisibility } from './mls';
import {
  MDK_KIND_CHAT,
  MDK_KIND_FILE,
  addMdkMembers,
  catchUpMdk,
  createMdkGroup,
  forgetMdkGroup,
  isMdkHandle,
  leaveMdkGroup,
  mdkGroups,
  openMdkChat,
  removeMdkMembers,
  renameMdkGroup,
  sendMdk,
} from './mdkChat';

export { isMlsAdmin, loadMlsDeviceIndex } from './mls';
export type { MlsGroupRecord, MlsVisibility } from './mls';
export { mdkAvailable } from './mdkChat';

export type MlsEngine = 'ts-mls' | 'mdk';

export function listMlsGroups(ownerPubKey?: string): MlsGroupRecord[] {
  return [...tsMls.listMlsGroups(ownerPubKey), ...mdkGroups(ownerPubKey)];
}

export async function loadMlsIndex(pubkey: string): Promise<MlsGroupRecord[]> {
  const own = await tsMls.loadMlsIndex(pubkey);
  return [...own, ...mdkGroups(pubkey)];
}

/** ts-mls's key package. MDK publishes its own when it opens. */
export function publishMlsKeyPackage(
  walletId: number,
  relays?: string[]
): Promise<void> {
  return tsMls.publishMlsKeyPackage(walletId, relays);
}

/** A new group. `engine: 'mdk'` makes an MDK group; private groups are
 *  ts-mls's alone. */
export function createMlsGroup(
  walletId: number,
  name: string,
  myPubkey: string,
  opts?: { visibility?: MlsVisibility; relays?: string[]; engine?: MlsEngine }
): Promise<MlsGroupRecord> {
  if (opts?.engine === 'mdk' && opts.visibility !== 'private') {
    return createMdkGroup(name, [], opts.relays ?? []);
  }
  return tsMls.createMlsGroup(walletId, name, myPubkey, opts);
}

export async function addMlsMember(
  walletId: number,
  handle: string,
  inviteePubKey: string,
  relays?: string[],
  opts?: { deviceIndex?: number }
): Promise<void> {
  if (isMdkHandle(handle)) return addMdkMembers(handle, [inviteePubKey]);
  return tsMls.addMlsMember(walletId, handle, inviteePubKey, relays, opts);
}

export async function removeMlsMember(
  walletId: number,
  handle: string,
  memberPubKey: string,
  relays?: string[]
): Promise<void> {
  if (isMdkHandle(handle)) return removeMdkMembers(handle, [memberPubKey]);
  return tsMls.removeMlsMember(walletId, handle, memberPubKey, relays);
}

export async function renameMlsGroup(
  walletId: number,
  handle: string,
  name: string,
  relays?: string[]
): Promise<void> {
  if (isMdkHandle(handle)) return renameMdkGroup(handle, name);
  return tsMls.renameMlsGroup(walletId, handle, name, relays);
}

export async function leaveMlsGroup(
  walletId: number,
  handle: string,
  relays?: string[]
): Promise<void> {
  if (isMdkHandle(handle)) return leaveMdkGroup(handle);
  return tsMls.leaveMlsGroup(walletId, handle, relays);
}

export async function forgetMlsGroup(
  handle: string,
  myPubkey: string
): Promise<void> {
  if (isMdkHandle(handle)) return forgetMdkGroup(handle);
  return tsMls.forgetMlsGroup(handle, myPubkey);
}

export async function linkOwnDevice(
  walletId: number,
  handle: string,
  extraDeviceIndex?: number,
  relays?: string[]
): Promise<void> {
  if (isMdkHandle(handle)) {
    throw new Error(
      'Linking another device is not available in MDK groups yet'
    );
  }
  return tsMls.linkOwnDevice(walletId, handle, extraDeviceIndex, relays);
}

export function sendMlsMessage(
  walletId: number,
  handle: string,
  roomId: string,
  text: string,
  relays?: string[]
): Promise<{ id: string; at: number }> {
  if (isMdkHandle(handle)) return sendMdk(handle, MDK_KIND_CHAT, text);
  return tsMls.sendMlsMessage(walletId, handle, roomId, text, relays);
}

export function sendMlsFile(
  walletId: number,
  handle: string,
  roomId: string,
  dataUrl: string,
  relays?: string[],
  extra?: { mimeType?: string; fileName?: string }
): Promise<{ id: string; at: number }> {
  if (isMdkHandle(handle)) {
    const tags = [['file-type', extra?.mimeType || 'application/octet-stream']];
    if (extra?.fileName) tags.push(['filename', extra.fileName]);
    return sendMdk(handle, MDK_KIND_FILE, dataUrl, tags);
  }
  return tsMls.sendMlsFile(walletId, handle, roomId, dataUrl, relays, extra);
}

export async function refetchMlsInbox(
  walletId: number,
  onMessage: (m: ChatMessage) => void,
  relays?: string[]
): Promise<void> {
  await tsMls.refetchMlsInbox(walletId, onMessage, relays);
  // What MDK reads arrives through its subscription's handlers.
  await catchUpMdk();
}

/** ts-mls's inbox, and MDK's when `mdk` is on. */
export function subscribeMls(
  walletId: number,
  onMessage: (m: ChatMessage) => void,
  relays?: string[],
  opts?: {
    mdk?: boolean;
    onGroups?: () => void;
    onError?: (error: unknown) => void;
  }
): () => void {
  let closed = false;
  let closeMdk: (() => void) | null = null;
  const closeTs = tsMls.subscribeMls(walletId, onMessage, relays);
  if (opts?.mdk) {
    openMdkChat(walletId, relays ?? DEFAULT_RELAYS, {
      onMessage,
      onGroups: opts.onGroups,
      onError: opts.onError,
    })
      .then((close) => {
        if (closed) close();
        else closeMdk = close;
      })
      .catch((error) => opts.onError?.(error));
  }
  return () => {
    closed = true;
    closeTs();
    closeMdk?.();
  };
}
