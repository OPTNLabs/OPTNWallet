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
