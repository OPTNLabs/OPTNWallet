# Reviewed public Electrum catalog snapshot

Electron Cash commit `bb67161b162c1eea2ed2128dc224f7c55532cb8f`, `electroncash/servers*.json`, retrieved 2026-09-19.
Source: https://github.com/Electron-Cash/Electron-Cash/tree/bb67161b162c1eea2ed2128dc224f7c55532cb8f/electroncash
Upstream license: MIT, https://github.com/Electron-Cash/Electron-Cash/blob/bb67161b162c1eea2ed2128dc224f7c55532cb8f/LICENCE.

These are unverified discovery hints, not evidence of availability or capabilities.
Use each network's TLS port exactly as supplied. TCP-only entries are not enabled
by this TLS bootstrap loader. Reading the catalog performs no network requests.
Updates must preserve endpoint-derived source IDs and apply the durable user overlay.

## General Protocols server list (2026-10-08)

`servers_electrum_cash.json` pins General Protocols' `electrum-cash/servers` commit
`36ffc06fa6ccbf98d171bf56a32e93ba3145b132` (2026-10-02), `source/{mainnet,chipnet,testnet}.ts`.
Source: https://gitlab.com/electrum-cash/servers/-/tree/36ffc06fa6ccbf98d171bf56a32e93ba3145b132/source
Upstream license: MIT, https://gitlab.com/electrum-cash/servers/-/blob/36ffc06fa6ccbf98d171bf56a32e93ba3145b132/LICENSE.

Its `testnet` list is testnet4; it publishes no testnet3 list. Hosts Electron Cash
already ships stay one candidate credited to both projects. The list adds
`testnet4.imaginary.cash` (testnet4) and `fulcrum.greyh.at` (mainnet). On 2026-10-08
all seven listed TLS endpoints answered as Fulcrum and returned the expected block
hash at the network's `electrum-cash/checkpoint` height; that is review evidence
only, and these remain unverified discovery hints at runtime.

## Metadata services (2026-09-26)

The Rust catalog also supplies optional BCMR candidate-byte retrieval:

- Mainnet: `bcmr.paytaca.com`, from [Paytaca's Mainnet deployment example](https://github.com/paytaca/bitcoincash-explorer/blob/fa85e5017b405b0999a0b266c2db797e34ae8386/.env.mainnet.example).
- Chipnet: `bcmr-chipnet.paytaca.com`, from [Paytaca's Chipnet deployment example](https://github.com/paytaca/bitcoincash-explorer/blob/fa85e5017b405b0999a0b266c2db797e34ae8386/.env.chipnet.example).
- Both: `ipfs.io`, the [public path gateway](https://docs.ipfs.tech/concepts/public-utilities/).

These HTTPS entries require the existing selected-source policy and verified Tor
adapter. Indexer or gateway responses are not identity proof: only bytes matching
the locally authenticated chain publication are accepted. Listing entries neither
contacts them nor marks capabilities verified. IPFS is network-independent; BCMR
origins are not shared across chains. Testnet3/Testnet4/Regtest receive none of these
metadata defaults. A ban remains in the user overlay when the base is refreshed.

`dweb.link` is not an independent fallback: upstream documents that it shares the
`ipfs.io` backend and rate limits, and its subdomain redirects require a different
origin policy. Paytaca's IPFS gateway requires an access token, so it is not shipped
as an anonymous default. TokenIndex and Chaingraph query adapters remain gated.

## BCH P2P DNS seeds (2026-10-10)

`p2p_seeds.json` holds the DNS seeds of the four node implementations #75 §21.3
names, each list exactly as its source has it at a pinned commit. Only the host
names are taken.

| Project | Source | Licence |
| --- | --- | --- |
| BCHN | [`src/chainparams.cpp` at `abd433ab`](https://gitlab.com/bitcoin-cash-node/bitcoin-cash-node/-/blob/abd433abe04f74780744b9eac06731f3690ce68a/src/chainparams.cpp) (2026-10-08) | MIT |
| Flowee the Hub | [`hub/server/chainparams.cpp` at `69efc094`](https://codeberg.org/Flowee/thehub/src/commit/69efc094a72dcc6733aaff55e088f27ebf77bad5/hub/server/chainparams.cpp) (2026-07-30) | GPL-3.0-or-later |
| bchd | [`chaincfg/params.go` at `cd36a647`](https://github.com/gcash/bchd/blob/cd36a6472f8ca7a5319439b8e9a81bba5c4023e5/chaincfg/params.go) (2026-10-09) | ISC |
| Knuth | [`src/network/src/settings.cpp` at `875fe334`](https://github.com/k-nuth/kth/blob/875fe334b8c28db706b1e60285092bbde39ea664/src/network/src/settings.cpp) (2026-08-31) | MIT |

The ports are each network's P2P port: 8333, 18333 (testnet3), 28333
(testnet4) and 48333 (chipnet). All four projects agree; Flowee's are in
`libs/utils/SettingsDefaults.h`. Scalenet seeds are left out, since OPTN has no
scalenet, and regtest has none. A seed several projects list is one candidate
credited to each.

A seed is a `p2p-seed` endpoint, never a peer: the nodes it names are. With Tor
off it is looked up by DNS. With Tor on its name goes to Tor and the node it
leads to is asked for addresses (`getaddr`), so nothing is resolved here. Only
public addresses on the seed's port are dialled (`optn-chain-native`).

Checked on 2026-10-10. A script compared every list with its file, and every
list matched. Every seed was then looked up. These did not resolve:

- `seed-bch.bitcoinforks.org` (mainnet);
- `testnet-seed-bch.bitcoinforks.org` and `testnet-seed.bchd.cash` (testnet3);
- `testnet4-seed.bchd.cash` (testnet4).

`seed.bchd.cash` failed once and answered the next time. They stay, since
upstream lists them: a seed that does not answer is reported and others are
asked. That is review evidence only; at run time every seed is an unverified
hint.
