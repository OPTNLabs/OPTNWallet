# Transport policy, CashFusion and discovered servers

Status: proposal for review. Nothing here is implemented yet.

This settles three questions against the architecture in #75. First, how the
privacy selector decides between Tor and a direct connection. Second, how
CashFusion's need for Tor fits that selector without overruling it. Third, how
servers discovered from Fulcrum peer lists join the source catalog.

## What the issues require

- **One transport policy for everything (#75 §4.1).** Direct, Tor and a
  configured proxy are a cross-cutting transport policy. Chain providers,
  Nostr, CashFusion, chat, BCMR and IPFS retrieval, index providers and
  explorer requests all consume it. "Individual features MUST NOT each invent
  their own independent Tor policy."
- **Ownership is not transport (#75 §4.1, §21.1).** "`Own infrastructure only`
  continues to restrict which sources are eligible, while Tor/proxy policy
  controls how eligible endpoints are reached. Neither one should be encoded
  as the other."
- **No implicit downgrade (#75 §4.1, §21.5).** If the active policy requires
  Tor and a route cannot satisfy it, the route is ineligible and fails closed.
  "Crossing from a privacy-required Tor/proxy route to Direct is a separate
  boundary and must likewise never happen implicitly."
- **Bootstrap feeds (#75 §21.3).** Fulcrum `server.peers.subscribe` is one of
  the feeds. Entries go "normalize + deduplicate → candidate source →
  handshake / protocol metadata → active capability probe → usable source
  catalog". Bootstrap entries are hints, not trust anchors.
- **Lifecycle and scope (#75 §21.2, §21.5, §21.6).** Bootstrap entries can be
  disabled or banned but not removed. Crossing from own infrastructure to
  public sources must be explicit. A preferred source outranks the remaining
  allowed ones.

## What the code does today

- The Rust stack (desktop sync, token identity, CLI) applies CashFusion's rule
  to every connection. Any remote, non-own endpoint needs trusted Tor or is
  refused (`optn-chain-native::native_chain_route` → `optn_core::tor::route`).
  A declared own-infrastructure source is always dialled directly.
  - That is the encoding §4.1 forbids: ownership decides transport.
  - The selector has no say: there is no transport field in
    `ConnectionPolicy`.
- The old UI's Tor switch (`torEnabled`, on by default) lives under
  *Server & privacy* next to CashFusion. The TypeScript Fusion paths and the
  Cash Code node scan read it. The Rust stack ignores it.
- Registry and IPFS bytes are fetched only over verified Tor
  (`registry_fetch.rs`).
- Peers returned by `server.peers.subscribe` are fetched at connect and then
  dropped.

## Proposal

### 1. The selector owns transport

The network policy (`ConnectionPolicy`, persisted in the network overlay) gains
a transport rule, chosen in the same selector as scope and protocols:

| Transport | Remote public sources | My infrastructure | Loopback |
| --- | --- | --- | --- |
| **Tor, except my infrastructure** (default) | Tor | Direct | Direct |
| **Tor for everything** | Tor | Tor: the node must be reachable through Tor, e.g. an onion service | Direct |
| **Direct** | Direct | Direct | Direct |
| **Proxy** (later) | Configured proxy | Per the same rule | Direct |

The default rule is exactly what the code does today, so existing users see no
change. It stops being an implicit encoding: own infrastructure is direct
because the holder's transport choice says so, and a holder who wants strict
Tor can choose "Tor for everything". Loopback is always direct. It has no
network hop to hide, and Tor cannot reach it.

The Tor switch in the old UI becomes this selector, read from and written to
the Rust overlay, so the desktop app, the CLI and Fusion all answer to one
setting.

### 2. CashFusion requires a private transport; it never overrides one

Fusion becomes an operation with a transport requirement, not a second
policy. Its legacy *server*, *pool*, *peer-input lookup*, *Electrum lookup*
and *covert endpoint* connections need the selector's transport for that
destination to be Tor or a proxy:

- Under either Tor rule, the default included, Fusion runs over Tor exactly
  as today. Public fusion servers are public sources, so they always go
  through Tor.
- Under **Direct**, Fusion does not run. Its settings and Auto Fusion say why:
  "CashFusion needs Tor. Your network policy connects directly." The holder's
  choice is never overridden, and Fusion is never run in the clear.
- A fusion server the holder declared as their own infrastructure follows the
  transport rule like any of their sources.

Because Tor is the default, Fusion works out of the box. The cost of turning
Tor off is visible, which encourages keeping it on without forcing it.

### 3. Discovered Fulcrum servers are bootstrap candidates

After a validated connection (genesis checked), the advertised peers are
normalised. TLS hostnames are kept, and onion hosts only when Tor is in use.
They are ingested with provenance `FulcrumPeerNetwork` and the advertising
server named:

- **Lifecycle:** as a bootstrap entry. They can be disabled or banned, with
  bans keyed by a stable ID and surviving restarts. They cannot be removed;
  they simply stop appearing when no server advertises them any more.
- **Eligibility:** only under scopes that admit public bootstrap sources
  (*All enabled* and *Public enabled*, or a fallback scope that adds them).
  Never under *My infrastructure* or an explicit list, so the selector's scope
  is honoured.
- **Order:** after preferred and shipped sources, with the same health and
  backoff ranking (§21.6 "remaining allowed sources"). Auto reaches them only
  when everything ranked above is unavailable: failover, as asked.
- **Trust:** capabilities stay advertised until probed, and the same genesis
  check runs on every connection. A discovered server never answers for
  another chain.
- **Bounds:** at most 32 per network are retained, refreshed on each
  connection.
- **Transport:** reached under the selector's rule, like any public source.

## Persistence and migration

The network overlay moves from schema 1 to schema 2:

- A `transport` field is added. Version 1 configurations migrate to
  *Tor, except my infrastructure*, which is today's behaviour.
- A bounded list of discovered peers is added, with provenance and last-seen
  time.

The migration is written atomically. A failed migration keeps the version 1
file untouched and the previous configuration in force (#75 §22.2, §22.4).
Tests:

- upgrade preserves custom sources, own-infrastructure groups, bans,
  ordering, protocol filters, fallback scopes and Tor trust;
- a failed write rolls back;
- portable export and import carry the transport rule but never machine-local
  proxy trust.
