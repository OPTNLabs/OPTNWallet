# Transport policy, CashFusion and discovered servers

Status: implemented in #108.

This settles three questions against the architecture in #75:

1. How Tor is switched on and off for the whole wallet.
2. How CashFusion's need for Tor fits that switch without overruling it.
3. How servers discovered from Fulcrum peer lists join the source catalog.

## What the issues require

- **One transport policy for everything (#75 §4.1).** Direct, Tor and a
  configured proxy form one cross-cutting transport policy. Chain providers,
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

## 1. Tor on or off, for everything

The network policy (`ConnectionPolicy`, persisted per network) carries one
transport rule. The holder sees it as a single switch, under
*Settings → Servers → Privacy & Transport*, or `optn network tor on|off`:

| Tor | Public sources | Sources you added as your own | Loopback |
| --- | --- | --- | --- |
| **On** (default) | Tor | Direct | Direct |
| **Off** | Direct | Direct | Direct |

"On" is what every route already did, so existing users see no change.
A node the holder declared as their own already knows who is asking, so it is
reached directly. Loopback has no network hop to hide, and Tor cannot reach
it.

The switch reaches every consumer:

- chain routes (Electrum, BIP37, Neutrino);
- the Tor-need probe, which also decides whether the app starts its own Tor;
- BCMR and IPFS retrieval;
- Cash Code scans and the legacy SPV commands;
- CashFusion (section 2).

With Tor on, a route that needs Tor and has no verified one is refused, never
dialled directly.

Direct registry fetches from origins the holder did not declare resolve only
to public addresses. A URI published on chain therefore cannot aim the wallet
at its own network.

Remote full-node RPC and ZMQ stay local-only in both states. Their adapters
cannot use a proxy, and RPC credentials are kept for loopback endpoints only.

The renderer's old `torEnabled` flag now mirrors this switch. Rust checks the
rule again on every call.

### Everything the app does for the renderer

The webview never reaches the network itself. Its CSP allows only the app's
own origin, IPC and loopback, so a direct request is blocked rather than
merely avoided. The Vite dev server sends the same policy, so this holds in
development too. Everything goes through Rust (`src-tauri/src/egress.rs`),
which applies the switch through one rule (`decide`):

- **Which switch.** A request answers to the shared runtime's network and to
  the network of the window that made it. If either network's switch is on,
  it goes through Tor. A host counts as the holder's own node only if it is
  declared own on both.
- **HTTP** (`fetch`) goes through `optn_http_fetch`. It is limited to the hosts
  the old CSP allowed, so routing through Rust adds privacy, never new
  destinations. Each redirect is re-checked, identity headers are stripped,
  and sizes are bounded.
- **WebSockets** go through `optn_ws_open`. `socket-bridge.ts` replaces
  `WebSocket` before any library loads, so WalletConnect, CashConnect,
  WizardConnect and Nostr all use it. A socket closes with the page that
  opened it, and every one closes when the switch changes, so none outlives
  the rule it was opened under. P2P Fusion's relay pools are given their own
  Tor-only socket and never use this one.
- **Images** named by dApps, add-ons, indexers and token registries come
  through `optn_remote_image` as bounded `data:` URLs (`RemoteImg`,
  `RemoteBackground`). Only `https` names, never an IP literal or `localhost`.
- **The legacy TypeScript Electrum client's native socket**
  (`electrum_tcp_connect`) follows the switch. So do the price fetch and the
  update check.
- **With Tor off**, a public name must resolve to public addresses, and the
  connection goes to the address that was checked, so DNS cannot point a
  request at the holder's own network. The holder's declared nodes and
  loopback are exempt.
- **Links** open in the system browser, which is outside every route this
  app controls. With Tor on, Rust refuses until the holder confirms, because
  the site would see their IP and, for an explorer, which transaction or
  address is theirs.

With Tor on and no verified Tor, every one of these is refused. None goes
direct.

## 2. CashFusion requires Tor; it never overrides the switch

CashFusion is private only over Tor. Every remote leg needs Tor with
provenance, exactly as before:

- server;
- pool;
- peer-input lookup;
- Electrum lookup;
- covert endpoints;
- P2P Nostr relays.

P2P relay connections no longer accept a proxy port from the renderer.

- **Tor on:** Fusion runs over Tor, as before.
- **Tor off:** Fusion does not run. It is refused before any proxy is
  consulted, with "CashFusion needs Tor, and Tor is off. Turn it on in
  Settings > Servers > Privacy & Transport to fuse." The holder's choice is
  never overridden, and Fusion is never run in the clear.

Because Tor is on by default, Fusion works out of the box. Turning Tor off
shows its cost plainly.

## 3. Discovered Fulcrum servers are failover candidates

Every Electrum server the wallet connects to is asked for its peers
(`server.peers.subscribe`, after the genesis check). The answer is filtered:

- TLS hostnames are kept. Onion hosts are kept only while Tor is on.
- IP literals and local or single-label names are dropped, so a server
  cannot point the wallet at the holder's own network.
- Servers the catalog already has are dropped.

What is left goes to a small per-network cache file,
`discovered-peers-<network>.json`, beside the settings files and never
inside them. Recording a peer is therefore never a settings edit: it revokes
no routes, interrupts no sync and travels in no backup.

- **Lifecycle:** a bootstrap entry, `FulcrumPeerNetwork`, naming the server
  that advertised it. It can be disabled or banned from the Servers screen,
  where it reads "Discovered from a server's peer list", or with `optn network
  disposition`. The ban lives in the settings overlay, keyed by the server's
  stable ID, so it holds when the server is found again. It cannot be removed;
  it is forgotten after 30 days unadvertised.
- **Eligibility:** only under scopes that admit public sources (*All
  enabled*, *Public enabled*, or a fallback that adds them). Never under *My
  infrastructure*, an explicit list, or the old server fields' "only my
  server". An idle install with no wallet open never gains them.
- **Order:** after every shipped and user source. A build dials them only when
  no other Electrum route connected, three at most, in their order. That is
  the failover.
- **Trust:** capabilities stay advertised until probed, and every connection
  runs the same genesis check. A discovered server never answers for another
  chain.
- **Bounds:** at most 32 per network, newest first. Seeing a known server
  again within a day does not rewrite the file.
- **Transport:** reached under the Tor switch, like any public source.
- **Shared:** the desktop app and the CLI read and keep the same cache.

## Persistence and migration

The network overlay moved from schema 1 to schema 2:

- **The `transport` field.** Its values are `tor` and `direct`. Schema-1 files
  read as `tor`, which is how they were always reached. Every other field is
  kept: sources, groups, bans, ordering, protocol filters, fallback scopes,
  explorer and proxy trust.
- **Writes.** A migrated file changes only on a successful atomic save. A read
  never writes, and a file this build cannot read is left untouched.
- **Versions.** Schemas outside 1..=2 are refused, never reset. A schema-2
  file must name a transport this build knows.
- **Backups.** Portable export and import carry the Tor setting, but never
  machine-local proxy trust.
- **Other writers.** Choosing a preset, pinning a source, editing the
  selection or saving the old one-server fields never changes the switch. No
  setting of it makes the old server fields unreadable or widens "only my
  server".
- **Discovered peers.** They are not part of the schema. They live in their
  own cache file (section 3), because they are not the holder's intent.
