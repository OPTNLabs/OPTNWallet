# Nostr chat — three tiers

Canonical map of how OPTN Wallet chat is supposed to work. Read this before
changing `chat.ts`, `mls.ts`, or the messenger UI.

**Status:** Implemented on the Paytaca-chat-interop branch. DMs interoperate
with Paytaca NIP-17. MLS groups use the Marmot `ts-mls` fork (AppDataUpdate
`0x0008`) plus NIP-ee event kinds. Chat never
broadcasts a spend; a `/send` tip only navigates to the existing send-confirm
flow.

**Normative code**

| Path | Role |
| ---- | ---- |
| `src/features/nostr/NostrChat.tsx` | Two-pane UI; picks the tier |
| `src/platform/desktop/nostr/chat.ts` | NIP-17 DMs, reactions, deletes, profiles |
| `src/platform/desktop/nostr/mls.ts` | MLS engine + private/open transport |
| `src/platform/desktop/nostr/mlsKeys.ts` | Ed25519 MLS keys (not the npub) |
| `src/platform/desktop/nostr/mlsDevice.ts` | Device slot, stored KeyPackage, coalesce by npub |
| `src/platform/desktop/nostr/mlsIdentityProof.ts` | Marmot `0xF2F1` account-identity-proof |
| `src/platform/desktop/nostr/mlsGroupData.ts` | Marmot `0xF2EE` group-data bytes |
| `src/platform/desktop/nostr/identity.ts` | Account seed (NIP-06 today) → npub |
| `src/platform/desktop/nostr/__tests__/chat.test.ts` | DM wrap/unwrap, tips, 10050 |
| `src/platform/desktop/nostr/__tests__/mls.test.ts` | MLS ratchet, 443/444/445, private wrap |

Public specs: [NIP-17](https://nips.nostr.com/17),
[NIP-44](https://nips.nostr.com/44),
[NIP-59](https://nips.nostr.com/59),
[NIP-ee](https://nips.nostr.com/ee),
[RFC 9420 MLS](https://www.rfc-editor.org/rfc/rfc9420.html).
Paytaca’s published DM stack is NIP-17 (see
[paytaca-app v0.25.0](https://github.com/paytaca/paytaca-app/releases/tag/v0.25.0)).

---

## The one-sentence rule

| Tier | What it is |
| ---- | ---------- |
| **DM** | 1:1 NIP-17 gift-wrap. Paytaca speaks this. No forward secrecy. |
| **Private group** | MLS crypto, NIP-17 *transport*. Gift-wrap the MLS blob to each member. Capped at **8**. Relays do not see a group id. |
| **Open group** | MLS crypto, NIP-ee *transport*. One kind-**445** event with an `h` tag. Still E2EE. “Open” means the *group exists* on relays, not that the text is public. |

You cannot bolt MLS forward secrecy onto a kind-14 rumor. Kind 14 always uses a
static NIP-44 conversation key from the two nsecs. Private groups keep gift-wrap
for metadata and put MLS *inside* the wrap.

NIP-17 itself says rooms with more than about 10 people should use another
scheme. The cap is `PRIVATE_MLS_MAX_MEMBERS = 8` in `mls.ts`.

---

## Comparison

| | DM | Private group | Open group |
| --- | --- | --- | --- |
| How the user starts it | One npub / hex | Comma-separated npubs (2–8) | **New MLS group** |
| Members | 2 | 2–8 | Uncapped (MLS tree) |
| Crypto | NIP-44 from identity keys | MLS (RFC 9420) | MLS (RFC 9420) |
| Transport | Kind 14 sealed, kind **1059** wrap | Same 1059 wrap; inner rumor is unsigned kind **445** carrying MLS bytes | Kind **445** published on relays |
| Relay-visible group id | None | None (outer 1059 has only `p`) | `h` = `nostr_group_id` (not the MLS group id) |
| Forward secrecy | No | Yes | Yes |
| Post-compromise security | No | Yes (later epochs) | Yes |
| Steal nsec later | Decrypts this DM history | Unwraps 1059s; still cannot read MLS without the ratchet | Cannot read MLS without the ratchet |
| Signing key ≠ npub | No | Yes — Ed25519 `m/44'/1237'/0'/0/(1+n)` | Same |
| 445 author | — | Throwaway wrap key (outer) | Fresh ephemeral secp256k1 per event |
| Recover from nsec only | Yes, refetch 1059s | No — need persisted `ClientState` | No — need persisted `ClientState` |
| Second device, same nsec | Works | Extra leaf, same npub (Add + Welcome). UI coalesces members | Same |
| Need peer KeyPackage first | No | Yes (kind 443 or Paytaca 30078) | Yes |
| Paytaca 1:1 | Yes | No | No |
| Paytaca NIP-17 “groups” | Their comma-rooms are still kind 14 | We do **not** dual-write kind 14 (that would drop FS) | No |
| Paytaca MLS 30078 | — | Dual-publish only if the invitee had a Paytaca KeyPackage | Dual-publish if `paytacaDual` |
| White Noise / Marmot | No | Welcome is 444-in-1059 (NIP-ee). App messages stay wrapped, so they will not see 445 traffic | Kind 443 / 444 / 445. Create-time `0x0006` dictionary + `0x0008` AppDataUpdate. Private rooms still wrap, so they will not see public 445 |
| Cost per message | 2 wraps (self + peer) | One MLS encrypt + N wraps | One MLS encrypt + one 445 |
| UI code path | `sendDirectMessage` | `createMlsGroup({ visibility: 'private' })` + `sendMlsMessage` | `createMlsGroup({ visibility: 'open' })` + `sendMlsMessage` |

---

## How each tier works

### Keys

```
Nostr account seed (scheme nip06-bip39 today)
  BIP39 mnemonic → m/44'/1237'/{account}'/0/{index}
  ├─ index 0        secp256k1  → npub / nsec
  └─ index 1+n      Ed25519    → MLS sign key (device n)
```

`loadNostrAccountSeed` is the wallet hook. A later NIP or a moved wallet is a
new `NostrAccountSeed` scheme plus a branch there — chat/MLS keep calling the
same functions. Live scheme is still [NIP-06](https://nips.nostr.com/06).

Device 0 is `m/44'/1237'/0'/0/1`. An extra install of the same seed claims
slot `n>0` (`/0/2`, `/0/3`, …) and is a **separate MLS leaf** with the same
npub in the credential. That is RFC 9420 plus Marmot identity proof
(`marmot.account-identity-proof.v1`, LeafNode ext `0xF2F1`). The enrolled
device Adds the extra KeyPackage (kind 30443 `d=<n>`) and gift-wraps a Welcome
to the same npub. Marmot’s External Commit + AppEphemeral `0x0009` path is a
branch draft and is **not** implemented
([`features/multi-device.md`](https://github.com/marmot-protocol/marmot/blob/master/features/multi-device.md)).

The MLS sign key is never the Nostr identity. Kind 443 KeyPackages are still
*signed as Nostr events* by the identity key (NIP-ee requires that). Kind 445
open-group events are signed by a **new ephemeral secp256k1 key every time**.

### DM (NIP-17)

```
unsigned kind 14 rumor
  → kind 13 seal  (NIP-44 with sender nsec × recipient npub)
  → kind 1059 wrap (NIP-44 with a throwaway key × recipient npub)
```

Published to the recipient’s kind **10050** relays plus discovery
(`wss://relay.paytaca.com`). The wrap hides sender and plaintext from the
relay. The inner conversation key is permanent for that pair — that is why
there is no forward secrecy ([NIP-44 limitations](https://nips.nostr.com/44)).

Reactions (kind 7) and deletes (kind 5) are also gift-wrapped.

### Private group (MLS inside gift-wrap)

```
MLS application / commit / welcome
  → unsigned rumor (kind 445, inner `h` = nostr_group_id)
  → NIP-59 gift-wrap to each member (outer 1059, `p` only — no `h`)
```

Welcomes are unsigned kind **444**, also gift-wrapped (NIP-ee). Relays cannot
cluster the room. Adding a 9th member is rejected: create an open group instead.

### Open group (MLS on 445)

```
MLS message
  → NIP-44 using MLS exporter_secret labeled "nostr" (32 bytes)
  → kind 445, tags: [["h", <nostr_group_id>]]
  → signed by a fresh ephemeral key
```

The MLS group id (RFC 9420) is **never** published. The `h` tag is a separate
32-byte `nostr_group_id` from the `0xF2EE` group-data extension
(`mlsGroupData.ts`).

Application payload inside MLS is an **unsigned kind 9** (NIP-ee). Paytaca-only
peers may send raw UTF-8; `parseApplicationPayload` accepts both.

### Paytaca dual-publish

If an invitee’s KeyPackage was only on kind **30078** `d=paytaca:mls-key-package`,
the group sets `paytacaDual` and also publishes

`kind 30078 { data: { mlsKind: 30117|30118|30119, mlsMessage } }`.

That envelope is identity-signed (Paytaca’s wire). Do not add `p` member lists
to it.

---

## Persistence

| Store | Key | Contents |
| ----- | --- | -------- |
| IndexedDB | `nostr-chat:${npub}` | Decrypted DM/group transcript (local UX) |
| IndexedDB | `nostr-mls-index:${npub}` | `MlsGroupRecord` list (ids, visibility, members) |
| IndexedDB | `nostr-mls-ratchet:${npub}:${nostrGroupId}` | `encodeGroupState` blob |
| IndexedDB | `nostr-mls-device:${npub}` | MLS device slot (0 = primary) |
| IndexedDB | `nostr-mls-kp:${npub}:${slot}` | Published KeyPackage + private init keys |

MLS forward secrecy is only as good as this ratchet blob. It is not recoverable
from nsec alone. Do not log it. Do not put `privateKeyHex` on MLS key types.

---

## What chat must never do

- Authorize or broadcast a BCH/CashToken spend. Tips are markup (`/send 0.01 BCH`
  or `/send 10 token:<64hex>`) plus the existing send-confirm screen.
- Publish the RFC 9420 MLS group id on relays.
- Publish a private-group member list in kind 30078 metadata.
- Dual-write kind 14 for an MLS room.
- Put a private-chat photo on a CDN / Blossom / `https` URL. See
  [Private chat photos](#private-chat-photos).

---

## Private chat photos

**The leak we care about** is a picture sent **in a DM or MLS room** that
someone else fetches over HTTP. That host sees the viewer’s IP, which file,
and when. Kind 0 profile (name / bio / avatar) is a public phone book — not
this rule.

Do **not** upload an in-chat photo to nostr.build, IPFS gateways, or Blossom
and paste the URL in the message. A CDN is not anonymous; an IPFS/Blossom
HTTPS gateway still sees the GET.

**When we send in-chat images:** put the **bytes in the encrypted payload**.

| Tier | Where the bytes go |
| ---- | ------------------ |
| DM | NIP-17 gift wrap (kind **15** file message, or equivalent inside the wrap) |
| Private group | MLS application blob, still inside the 1059 wrap |
| Open MLS | MLS application blob on 445 — still E2EE, no public URL |

No `https://` in that payload. Relays already see wraps; we do not add an
image host. Strip EXIF before send. Keep it small (relay size limits).

In-chat send uses kind **15** (DM wrap) or MLS inner kind 15 with a
`data:image/jpeg;base64,…` body. Profile publish writes **kind 0** and Paytaca
kind **30078** (`paytaca:avatar` / `paytaca:display-name`) with the same inline
bytes. Refetch on the chat screen replays 1059s and MLS backups from relays.

---

## Avatars (profile, not private chat)

Kind 0 `{ name, about, picture }` is [NIP-01](https://nips.nostr.com/01).
Damus, Amethyst, Primal, Paytaca read it. That card is **public**. A `picture`
URL has the extra CDN GET; inline bytes in the event do not. This wallet
currently stores *our* chat-header photo in IndexedDB and does not `GET`
`http(s)` for avatars (`NostrChat` `Avatar`). That is UI, not the private-chat
photo rule above.

---

## Tests

```
npx vitest run src/platform/desktop/nostr/__tests__/chat.test.ts src/platform/desktop/nostr/__tests__/mls.test.ts
npx tsc -p tsconfig.core.json --noEmit
```

MLS tests cover: distinct Ed25519 vs npub, extra-device path `/0/2`, two-party
decrypt against the **receiver** state, Marmot 445 AEAD, unsigned 444 gift-wrap,
`0xF2EE` and `0x0006` dictionary bytes, `encodeGroupState` round-trip, private
wrap with no outer `h` tag, `0xF2F1` identity proof, same-npub extra leaf Add.

Ratchet bytes are stored locally and also gift-wrapped to self as
`optn:mls-backup:` so restoring the same seed can reload group state. Device 0
uses `m/44'/1237'/0'/0/1`; further devices increment the last index (one leaf
each). Credential identity is the 32-byte npub (Marmot). Each leaf carries
`marmot.account-identity-proof.v1`. Open 445 uses MLS-Exporter(`marmot`,
`group-event`, 32) then ChaCha20-Poly1305; NIP-ee NIP-44 decrypt remains a
fallback. Group create attaches Marmot `app_data_dictionary` (`0x0006`:
profile, admin-policy, routing, lifecycle) plus MIP-era `0xF2EE`. Dictionary
mutations use IETF `app_data_update` proposal `0x0008` via the same `ts-mls`
fork Marmot-ts pins (`hzrd149/ts-mls` `marmot-required-ext` @ `2ca5c43`). Do
not invent a custom proposal type. Published npm `ts-mls` 1.6.x / 2.0.0-rc.16
is RFC 9420 only. Extra devices are RFC 9420 Add, not draft External Commit. ts-mls’s default
KeyPackage equality also matches credentials; we compare signature keys only
so one npub can own multiple leaves.
