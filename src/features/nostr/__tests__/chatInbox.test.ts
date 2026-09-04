import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../../platform/desktop/nostr/chat';
import type { MlsGroupRecord } from '../../../platform/desktop/nostr/mls';
import {
  buildChatInbox,
  classifyChatPeer,
} from '../chatInbox';

const message = (
  partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'from' | 'text'>
): ChatMessage => ({
  to: [],
  at: 1,
  mine: false,
  ...partial,
});

const group = (
  partial: Partial<MlsGroupRecord> & Pick<MlsGroupRecord, 'roomId' | 'visibility'>
): MlsGroupRecord => ({
  nostrGroupIdHex: `${partial.roomId}-mls`,
  mlsGroupIdHex: `${partial.roomId}-tree`,
  wire: 'nip-ee',
  name: partial.name ?? partial.roomId,
  paytacaDual: false,
  memberPubKeys: ['me'],
  ownerPubKey: 'me',
  adminPubKeys: ['me'],
  ...partial,
});

describe('chat inbox sections', () => {
  it('keeps 1:1 DMs out of MLS group sections', () => {
    const inbox = buildChatInbox({
      messages: [
        message({
          id: 'dm1',
          from: 'alice',
          to: ['me'],
          text: 'hi',
          at: 10,
        }),
      ],
      groups: [],
      mePubKey: 'me',
      activePeer: null,
      query: '',
    });

    expect(inbox.dm.map((item) => item.id)).toEqual(['alice']);
    expect(inbox['private-group']).toEqual([]);
    expect(inbox['open-group']).toEqual([]);
  });

  it('lists private and open MLS groups even before the first message', () => {
    const inbox = buildChatInbox({
      messages: [],
      groups: [
        group({ roomId: 'priv-room', visibility: 'private', name: 'Family' }),
        group({ roomId: 'open-room', visibility: 'open', name: 'Town' }),
      ],
      mePubKey: 'me',
      activePeer: null,
      query: '',
    });

    expect(inbox['private-group'].map((item) => item.id)).toEqual(['priv-room']);
    expect(inbox['open-group'].map((item) => item.id)).toEqual(['open-room']);
    expect(inbox.dm).toEqual([]);
  });

  it('classifies a room by the stored MLS visibility, not by the message mix', () => {
    const groups = [
      group({ roomId: 'priv-room', visibility: 'private' }),
      group({ roomId: 'open-room', visibility: 'open' }),
    ];
    expect(classifyChatPeer('priv-room', groups)).toBe('private-group');
    expect(classifyChatPeer('open-room', groups)).toBe('open-group');
    expect(classifyChatPeer('bob', groups)).toBe('dm');

    const inbox = buildChatInbox({
      messages: [
        message({
          id: 'g1',
          from: 'alice',
          to: ['me'],
          text: 'secret',
          roomId: 'priv-room',
          at: 4,
        }),
        message({
          id: 'g2',
          from: 'carol',
          to: ['me'],
          text: 'hello town',
          roomId: 'open-room',
          at: 8,
        }),
        message({
          id: 'dm',
          from: 'bob',
          to: ['me'],
          text: 'hey',
          at: 9,
        }),
      ],
      groups,
      mePubKey: 'me',
      activePeer: null,
      query: '',
    });

    expect(inbox.dm.map((item) => item.id)).toEqual(['bob']);
    expect(inbox['private-group'].map((item) => item.id)).toEqual(['priv-room']);
    expect(inbox['open-group'].map((item) => item.id)).toEqual(['open-room']);
  });
});
