# Paytaca Nostr chat parity plan

How OPTN chat is split (DM vs private MLS vs open MLS) is documented in
[nostr-chat-tiers.md](./nostr-chat-tiers.md). This file is only the leftover
Paytaca-app UX checklist, not the protocol map.

Comparison baseline:
[Paytaca `src/wallet/nostr.js` at c036cb65](https://github.com/paytaca/paytaca-app/blob/c036cb65a8f40a32a823d8eb0daff5ce2b5c5e3d/src/wallet/nostr.js)
and its chat UI at the same revision.

## Present in OPTN

- NIP-06 identity on the separate `m/44'/1237'/0'/0/0` path.
- NIP-17 kind-14 rumors, NIP-44 encryption, NIP-59 kind-1059 gift wraps, and a
  sender copy.
- Recipient kind-10050 relay discovery plus publication of the wallet's own DM
  relay list.
- Kind-0 profile lookup/publication with display name and avatar.
- Local per-Nostr-identity message persistence, conversation list, contact
  profiles, sent-message insertion after the publication attempt returns, relay
  reachability, and a responsive two-pane DM UI.
- Default-on chat with an explicit user opt-out. Opting out prevents the chat
  client from mounting, so it does not derive an identity, publish a relay list,
  or start subscriptions.

## Partial

- OPTN persists a local sender copy but does not publish Paytaca's real-key,
  relay-queryable self-signed archive wrap for history recovery.
- OPTN unwraps NIP-17 events, but it does not independently surface Paytaca's
  seal-pubkey-versus-rumor-pubkey verification result.
- Relay publication currently uses `Promise.allSettled`; a fulfilled sender-copy
  publish can mask recipient delivery failure, and some connection failures are
  returned as fulfilled status strings. There is no verified recipient-delivery
  state or relay-by-relay diagnostic yet.

## Not yet at Paytaca parity

- Deterministic group rooms, member management, group metadata, invitations,
  leave/rejoin, and group blocking.
- Conversation subjects, replies, edits, deletions, emoji reactions, read
  receipts, typing indicators, and active status.
- Contact save/rename/block, archive/unarchive, delete/reset, and relay-history
  reconstruction.
- Attachments, image/PDF handling, and upload/download safety limits.
  Avatars stay local on purpose (no kind-0 `picture` / no `https` fetch) until
  a private media path exists — [nostr-chat-tiers.md](./nostr-chat-tiers.md#avatars-until-a-private-media-path).
- Send-BCH/tip flow with wallet/network-aware confirmation.
- Conversation-info and group-info screens, message context actions, unread
  counts, date separators, pagination, and scroll restoration.
- Watchtower/push-notification behavior and self-wrap notification suppression.

## Delivery order

1. **Archive and verification:** validate rumor/seal authorship, add the
   self-signed archive wrap, replay history from relays, deduplicate reliably,
   and expose publish/delivery status.
2. **Message actions:** replies, edits, deletions, reactions, read receipts,
   subjects, and typing state using gift-wrapped events.
3. **Contacts and rooms:** saved contacts, block/archive/reset, deterministic
   group IDs, membership, and room metadata.
4. **Attachments and BCH tips:** bounded attachment handling and an explicit
   wallet send-confirmation flow. Chat content may suggest a payment but can
   never authorize spending.
5. **Interoperability:** two-way fixtures and live relay tests between OPTN and
   Paytaca for DMs, relay lists, archives, actions, and group rooms.

Each phase keeps private chat operational on all supported wallet networks; BCH
transactions always use the active wallet's network and normal confirmation
rules.
