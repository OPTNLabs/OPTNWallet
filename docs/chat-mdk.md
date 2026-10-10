# Marmot chat through MDK

The desktop chat has two MLS engines:

- **ts-mls** (`src/platform/desktop/nostr/mls.ts`): the original engine. It
  runs in the renderer and keeps every group it made. It is the default.
- **MDK** (`crates/optn-chat`, desktop module `src-tauri/src/chat_mdk.rs`):
  [MDK](https://github.com/marmot-protocol/mdk), the Marmot Development Kit
  from the rust-nostr project, used as published (`mdk-core` 0.8.0 from
  crates.io, unmodified). It runs in the Rust host and speaks current Marmot
  (MIP-00 to MIP-03), the protocol White Noise and other Marmot clients use.

Both engines read the same inbox at once. Each one takes the welcomes and
group events in its own format and ignores the other's, so turning MDK on
loses nothing ts-mls had. Which engine new groups use is the holder's choice,
and existing groups stay on the engine that made them.

## What MDK does here

| | |
| --- | --- |
| Key packages | kind 30443, base64 with an `encoding` tag. One slot per device (the `d` tag is kept in the engine's state file), so a rotated package replaces the last. Rotated weekly. The two newest keep their private keys, so a welcome for the one just replaced still opens. Kind 10051 lists the relays they are on. |
| Invitations | A member's key package is looked up on the relays their 10051 names, then ours. Newest first, the first one MDK accepts is used. Welcomes (kind 444) are gift-wrapped (NIP-59) to each member and sent to the relays their key package names. |
| Changes | Add, remove and rename are MLS commits. A commit is merged only once a relay holds it, and dropped if none does. Before committing, the engine reads the group's latest events, because a commit made from an older epoch forks the group and loses under MIP-03. A member's leave request is committed by whoever reads it, as MDK does. |
| Joining | Welcomes are accepted as they arrive, as ts-mls does. Each is accepted once: MDK returns a welcome it has already handled, and accepting that again would rebuild the group from the welcome's epoch. Each join is followed by a self-update (MIP-02), and leaf keys rotate every 30 days after that. |
| Messages | Text is kind 9 and inline files are kind 15 (a `data:` URL, as ts-mls sends them), as MLS application messages in kind 445 events tagged with the group's `h`. |
| Order | Relays order nothing beyond `created_at`, and MDK never retries an event it failed to read. So nothing is published in the same second as the newest commit the engine has made or read (waiting up to 3 s), and each read is sorted by time. |
| Reading | Catch-up reads the inbox (with the two days of NIP-59 timestamp skew) and every active group since the last read, then reads live. Every event read goes to one stream, once. MDK's own processed-event records decide what is new. |
| Store | MDK's SQLCipher store, `<app data>/chat-mdk/<pubkey>.mdk.sqlite`. Its key is HKDF-SHA256 of the chat identity's secret key, so whoever holds the wallet seed can open it and nobody else can. Beside it, a plain state file holds the key-package slot and read times; neither is secret. |
| Relays | `optn-nostr` (rust-nostr 0.45) over the desktop's own egress: the Tor switch, the holder's declared hosts, public addresses only for anyone else's relay, and `ws://` only on this machine. These are the same rules the renderer's relay sockets follow. |

## What MDK does not do (yet)

All of these were checked against `mdk-core` 0.8.0 and the ts-mls engine's
code. ts-mls keeps serving each case.

| Case | Why | Where it stands |
| --- | --- | --- |
| Inviting a ts-mls user into an MDK group | ts-mls publishes key packages in the first NIP-EE format: hex content, `ciphersuite` instead of `mls_ciphersuite`, and no `encoding`, `mls_proposals` or `i` tags. Its `d` is the device index, not 64 hex characters. MDK refuses them (`parse_key_package`). | The engine answers `NoKeyPackage`; the group can be made on ts-mls instead. Fix on the ts-mls side: publish MIP-00 key packages beside the old ones. |
| A ts-mls user reading MDK key packages or welcomes | ts-mls reads hex only (`keyPackageFromEventContent`, `hexToBytes(rumor.content)`). MDK writes base64 with an `encoding` tag. | Fix on the ts-mls side: decode by the `encoding` tag. |
| MDK joining a ts-mls group | ts-mls groups require the app-data dictionary extension (0x0006) and the AppDataUpdate (0x0008) and SelfRemove (0x000A) proposals. MDK 0.8 advertises only LastResort (0x000A) and group data (0xF2EE), with SelfRemove. | Needs MDK support for app data, or ts-mls groups that do not require it. |
| Account identity proof (0xF2F1) | An OPTN leaf extension that binds a leaf's MLS key to the Nostr account with a Nostr signature. MDK binds the two through the credential and the key package event's signature instead, and does not write 0xF2F1. | ts-mls groups that check it would refuse MDK leaves. |
| Group profile through app data | ts-mls renames through an AppDataUpdate profile component (0x8001). MDK renames through the 0xF2EE group data, as Marmot specifies. | Each engine renames its own groups its own way. |
| Private (gift-wrapped) groups | ts-mls "private" groups send each MLS message as a gift-wrapped kind-445 rumor, one per member (up to 8). Marmot has no such mode, and MDK reads group events only as kind 445 events on relays. | MDK groups are all relay groups; private groups stay on ts-mls. |
| Paytaca | The kind-30078 envelope with inner kinds 30117/30118/30119. | ts-mls only. |
| Existing ts-mls groups | ts-mls's group state is not OpenMLS's, so there is no conversion. | They stay on ts-mls. |
| Restoring on another device | ts-mls derives its MLS signing keys from the seed and backs its group state up to relays, gift-wrapped to itself. MDK's keys are random and live in its store. | An MDK store lost is its groups lost. The groups would need re-inviting. |
| Linking another device of the same account | ts-mls adds a second leaf for the same npub (`linkOwnDevice`). With MDK each device has its own key-package slot, but adding one's own other device was not tried. | Not ported. |
| Media other Marmot clients render | Inline `data:` files (kind 15) are what ts-mls sends. White Noise sends MIP-04 encrypted media (Blossom), which MDK has behind its `mip04` feature. | Not enabled: it needs a Blossom server choice. |

MDK's git `main` (0.12) is ahead of crates.io, but it is not published, and the
workspace policy refuses git dependencies, so the engine stays on 0.8.0 until a
release.

## Building

MDK's store is SQLCipher. Off Apple platforms its crypto is OpenSSL, built
from source with `libsqlite3-sys`'s `bundled-sqlcipher-vendored-openssl`
(Apple builds use CommonCrypto). OpenSSL's configure script needs a full Perl.
Git for Windows' Perl lacks `Locale::Maketext::Simple`, `IPC::Cmd` and others,
so on Windows `OPENSSL_SRC_PERL` must name Strawberry Perl:

```sh
OPENSSL_SRC_PERL=C:/Strawberry/perl/bin/perl.exe \
  npx --no-install tauri build --features mdk-chat
```

GitHub's Windows runners have Strawberry Perl at `C:/Strawberry/perl/bin`.
Without the `mdk-chat` feature the desktop builds as before and the chat runs
on ts-mls alone. `crates/optn-chat` builds without OpenSSL unless its `sqlite`
feature is on: its tests run MDK on its in-memory store against a local relay.
