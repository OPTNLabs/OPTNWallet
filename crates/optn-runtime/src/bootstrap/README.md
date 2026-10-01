# Reviewed public Electrum catalog snapshot

Electron Cash commit `bb67161b162c1eea2ed2128dc224f7c55532cb8f`, `electroncash/servers*.json`, retrieved 2026-09-19.
Source: https://github.com/Electron-Cash/Electron-Cash/tree/bb67161b162c1eea2ed2128dc224f7c55532cb8f/electroncash
Upstream license: MIT, https://github.com/Electron-Cash/Electron-Cash/blob/bb67161b162c1eea2ed2128dc224f7c55532cb8f/LICENCE.

These are unverified discovery hints, not evidence of availability or capabilities.
Use each network's TLS port exactly as supplied. TCP-only entries are not enabled
by this TLS bootstrap loader. Reading the catalog performs no network requests.
Updates must preserve endpoint-derived source IDs and apply the durable user overlay.

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
