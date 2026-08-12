# OPTN Wallet Event Add-on Integration Plan

## Current Direction

This document began from a wallet-first event model. The active MVP direction is now narrower:

- organizer and attendee only
- attendee registration can come from third-party platforms such as Luma
- token creation happens outside this system
- OPTN Wallet is optional and used for wallet linking plus reward receipt
- the backend is the source of truth for attendees, claims, entitlements, and distribution jobs

Use the backend implementation in `~/projects/events-Backend/` as the current source of truth for the MVP data model.

This plan assumes:

- `tokenIndexer` stays a separate token query service
- the attendee experience lives in OPTN Wallet under `src/pages/apps/`
- the backend server package lives separately under `~/projects/events-Backend/`
- a very small event backend is acceptable
- production TokenIndex endpoint is `https://tokenindex.optnlabs.com`

## 1. Wallet Integration Points

The current OPTN Wallet structure already supports a built-in event addon.

Relevant files in `OPTNWallet`:

- `src/addons/builtin/index.ts`
- `src/pages/apps/MarketplaceAppHost.tsx`
- `src/pages/apps/marketplaceScreenResolver.tsx`
- `src/pages/apps/mint-cashtokens-poc/MintCashTokensPoCApp.tsx`
- `src/services/AddonsSDK.ts`

### Recommended integration shape

Add a new built-in declarative app, for example:

- addon id: `optn.builtin.events`
- app id: `eventRewardsApp`
- screen id: `EventRewardsApp`

This fits the existing host/resolver model and avoids needing a new addon runtime.

Current built-in app config also supports a runtime override through:

- `localStorage["optn.eventRewards.apiBaseUrl"]`

## 2. What the Wallet App Should Do

The wallet addon should be attendee-focused only.

Initial screens:

### Screen A: My Events

Shows:

- event cards for passes detected in wallet
- active rewards/badges count
- quick entry into an event detail screen

Data sources:

- wallet UTXOs via `sdk.utxos.listForWallet()`
- local BCMR metadata via existing wallet BCMR service
- optional backend event metadata by token category

### Screen B: Event Detail

Shows:

- pass NFT
- event name, dates, venue
- sponsor rewards collected
- badges earned
- claim history from backend

Data sources:

- wallet token holdings
- backend event metadata
- backend claim history

### Screen C: Scan Claim

Used for:

- booth claim QR
- session badge QR
- scavenger checkpoint QR

Flow:

1. Scan QR
2. Decode signed payload
3. Submit selected wallet address or locking bytecode to backend
4. Poll claim result
5. Refresh wallet inventory

### Screen D: Rewards

Shows:

- sponsor FT balances
- collectible badge NFTs
- redemption status

## 3. Wallet SDK Capabilities Needed

For a built-in first version, the existing SDK is mostly enough.

Needed now:

- `wallet:context:read`
- `wallet:addresses:read`
- `utxo:wallet:read`
- `http:fetch_json`
- `ui:confirm`

Optional later:

- `tx:build`
- `tx:broadcast`

Those transaction capabilities are not required if the backend is the party sending rewards to attendees.

## 4. Backend Authentication

For this project, use message-signing backed authentication rather than anonymous address submission.

The preferred wallet signing helper is:

- `OPTNWallet/src/utils/signed.ts`

Do not base backend auth on `dataSigner.ts`.

Reason:

- `signed.ts` is closer to a wallet-auth sign/verify flow
- `dataSigner.ts` is a lower-level raw Schnorr helper better suited to contract-oriented `datasig` use

### Recommended auth model

Use a nonce-based challenge flow.

Flow:

1. Wallet requests a challenge for a claim action.
2. Backend returns a short-lived message string plus metadata.
3. Wallet signs the exact message using the `signed.ts` flow.
4. Backend verifies the signature against the submitted wallet address.
5. Backend checks token eligibility through `tokenIndexer`.
6. Backend accepts or rejects the claim.

### Why this is preferable

- prevents replay of old signatures
- ties the signature to a specific event action
- proves wallet control without requiring an on-chain transaction
- keeps sponsor and organizer logic off-chain

### Suggested challenge format

Use a deterministic multi-line text payload:

```text
optn-event-auth:v1
action=claim
event_id=<event_id>
campaign_id=<campaign_id>
wallet_address=<cashaddr>
nonce=<random_nonce>
issued_at=<unix_seconds>
expires_at=<unix_seconds>
```

For airdrop management or organizer actions, use a similar action-specific message:

```text
optn-event-auth:v1
action=sponsor-session
sponsor_id=<sponsor_id>
event_id=<event_id>
wallet_address=<cashaddr>
nonce=<random_nonce>
issued_at=<unix_seconds>
expires_at=<unix_seconds>
```

### Suggested attendee auth endpoints

- `POST /auth/challenge`
- `POST /auth/verify`

Example request:

```json
{
  "action": "claim",
  "event_id": "evt_123",
  "campaign_id": "camp_456",
  "wallet_address": "bitcoincash:..."
}
```

Example response:

```json
{
  "challenge_id": "chl_123",
  "message": "optn-event-auth:v1\naction=claim\n...",
  "issued_at": 1770000000,
  "expires_at": 1770000300
}
```

Verify request:

```json
{
  "challenge_id": "chl_123",
  "wallet_address": "bitcoincash:...",
  "signature": "<base64_or_wallet_signature_payload>"
}
```

Verify response:

```json
{
  "session_token": "<opaque_short_lived_token>",
  "expires_at": 1770000900
}
```

### Session model

After verify succeeds:

- backend returns a short-lived session token
- wallet uses that token on `POST /claims/scan`
- token lifetime can be short, e.g. `10-30m`

### Wallet requirement

Before implementation, confirm:

- exact signature output shape from `signed.ts`
- exact backend verification requirements for that format
- whether addon SDK should expose a reusable message-signing helper or whether the event app will call a shared wallet utility directly

## 5. Minimal Backend

Do not build a large service mesh. One small API with a relational DB is enough for MVP.

### Minimal backend responsibilities

- store events and campaigns
- generate and validate claim QR payloads
- issue and verify message-signing challenges
- verify pass ownership via `tokenIndexer`
- record claim attempts
- enqueue reward issuance
- expose simple analytics for organizers

### Suggested API surface

#### Public attendee endpoints

- `GET /events/by-pass/:category`
- `GET /events/:eventId`
- `POST /auth/challenge`
- `POST /auth/verify`
- `POST /claims/scan`
- `GET /claims/:claimId`
- `GET /wallet/:lockingBytecode/events`

#### Organizer endpoints

- `POST /admin/events`
- `POST /admin/events/:eventId/campaigns`
- `POST /admin/events/:eventId/claim-codes`
- `GET /admin/events/:eventId/claims`
- `POST /admin/events/:eventId/airdrops`

#### Sponsor endpoints

- `GET /sponsor/events/:eventId/campaigns`
- `GET /sponsor/campaigns/:campaignId/claims`
- `GET /sponsor/categories/:category/holders`
- `POST /sponsor/campaigns/:campaignId/airdrops`

#### Internal job endpoints

- `POST /internal/issuance/reward`
- `POST /internal/issuance/airdrop`

## 6. Minimal Backend Tables

You can keep the schema small.

### `events`

- `id`
- `name`
- `starts_at`
- `ends_at`
- `venue`
- `status`

### `event_passes`

- `id`
- `event_id`
- `category_hex`
- `pass_kind`

### `campaigns`

- `id`
- `event_id`
- `campaign_type`
- `name`
- `reward_category_hex`
- `reward_mode`
- `starts_at`
- `ends_at`
- `rule_json`

### `claim_codes`

- `id`
- `campaign_id`
- `code_hash`
- `payload_json`
- `expires_at`

### `claims`

- `id`
- `campaign_id`
- `wallet_locking_bytecode`
- `wallet_address`
- `pass_category_hex`
- `pass_nft_commitment`
- `status`
- `issued_txid`
- `created_at`

### `auth_challenges`

- `id`
- `action`
- `wallet_address`
- `subject_id`
- `nonce`
- `message`
- `issued_at`
- `expires_at`
- `used_at`

### `sponsors`

- `id`
- `event_id`
- `name`
- `reward_category_hex`
- `dashboard_status`

## 7. How tokenIndexer Should Be Used

Use `tokenIndexer` for reads only.

Default production base URL:

- `https://tokenindex.optnlabs.com`

### Pass ownership check

- `GET /v1/token/{passCategory}/holder/{lockingBytecode}`

### Wallet inventory

- `GET /v1/holder/{lockingBytecode}/tokens`

### Airdrop audience selection

- `GET /v1/token/{category}/holders`

### Sponsor self-service category management

Each sponsor should be able to manage their own token category independently.

That means the event backend can expose sponsor-scoped views derived from:

- `GET /v1/token/{category}/holders`
- `GET /v1/token/{category}/summary`
- `GET /v1/token/{category}/insights`

This covers:

- checking how many holders a sponsor reward category has
- exporting sponsor-specific recipient lists
- running sponsor-specific follow-up airdrops
- tracking sponsor campaign reach without exposing other sponsors' categories

### Metadata fallback

- `GET /v1/bcmr/{category}`

This means the event backend does not need its own chain indexer.

## 8. Reward Delivery Model

For the MVP, use backend-driven distribution.

Flow:

1. Wallet addon submits claim
2. Backend validates eligibility
3. Backend records claim as pending
4. Backend issues token send through your existing BCH/token infra
5. Backend marks claim settled with `txid`
6. Wallet refreshes holdings

This is simpler than trying to construct claim transactions on-device.

## 9. Wallet User Experience

The attendee experience should stay inside the wallet add-on as much as possible.

### Primary UX goals

- detect event passes already held in wallet
- make claims feel like a wallet-native action
- show sponsor rewards and badges without making users think about token categories

### Recommended event app flow

1. User opens `EventRewardsApp`
2. Wallet lists detected event passes from wallet holdings
3. User selects an event
4. User sees event details, active campaigns, collected rewards, and badges
5. User scans booth/session QR
6. Wallet signs challenge, submits claim, and shows pending/completed result
7. Reward appears in wallet inventory

### Important UI simplification

Do not expose raw category IDs in primary attendee views unless there is a debug mode.

The wallet should present:

- event name
- pass type
- sponsor name
- reward name
- badge title

using BCMR plus backend event metadata.

## 10. Phased Build Plan

### Phase 0: Validation

- confirm `signed.ts` output and backend verification format
- decide whether signing is exposed through addon SDK or a shared wallet helper
- define one event pass category and one sponsor reward category for pilot

### Phase 1: Minimal backend

- events
- campaigns
- QR payload issuance
- auth challenge/verify
- claims table
- tokenIndexer integration

### Phase 2: Wallet attendee app

- built-in addon registration
- `EventRewardsApp` screen wiring
- my events list
- event detail screen
- scan claim flow
- claim status polling

### Phase 3: Issuance integration

- reward send hook
- badge issuance hook
- tx status persistence

### Phase 4: Sponsor management

- sponsor-scoped campaign views
- sponsor category holder lookups through backend
- sponsor airdrop/export tools

### Phase 5: Organizer analytics

- event-wide claims
- reward totals
- segment builder for post-event airdrops

## 11. Recommended First Build

If the goal is the fastest coherent pilot:

1. Add a built-in `EventRewardsApp` to OPTN Wallet
2. Build one backend service with:
   - event metadata
   - QR claim validation
   - claim records
   - tokenIndexer lookups
   - reward issuance hooks
3. Support one event pass category and one sponsor reward token
4. Add organizer claim export and manual airdrop trigger

## 12. Immediate Engineering Recommendation

Start with these constraints:

- wallet-first identity
- static signed QR codes
- backend-issued rewards
- one claim per pass per campaign
- no ticket sales
- no message-sign auth in v1

That gives you a small but credible system:

- wallet addon for attendee UX
- tiny backend for orchestration
- tokenIndexer for target discovery and eligibility

If adoption is good, the first platform-level wallet enhancement to add is message signing for addons.

## 13. Backend Verification Contract

This section defines the exact contract the event backend should implement for wallet-authenticated claims.

### 13.1 Challenge request

Endpoint:

- `POST /auth/challenge`

Request body:

```json
{
  "action": "claim",
  "event_id": "evt_demo_2026",
  "campaign_id": "camp_booth_1",
  "wallet_address": "bitcoincash:q...",
  "network": "mainnet"
}
```

Rules:

- `action` is one of `claim`, `sponsor-session`, `organizer-session`
- `wallet_address` must be normalized by backend before challenge generation
- `campaign_id` is required for attendee claim auth
- challenges expire quickly, recommended `300` seconds

### 13.2 Challenge response

Response body:

```json
{
  "challenge_id": "chl_01hrxyz",
  "message": "optn-event-auth:v1\naction=claim\nevent_id=evt_demo_2026\ncampaign_id=camp_booth_1\nwallet_address=bitcoincash:q...\nnonce=3e9f0d...\nissued_at=1770000000\nexpires_at=1770000300",
  "wallet_address": "bitcoincash:q...",
  "issued_at": 1770000000,
  "expires_at": 1770000300
}
```

Backend persistence:

- store exact message string
- store normalized address
- store nonce
- mark challenge as unused

### 13.3 Wallet signing step

Wallet behavior:

1. receive `message`
2. call addon SDK `sdk.signing.signMessage({ address, message })`
3. return the recoverable `signature` field to backend

The SDK payload is:

```json
{
  "address": "bitcoincash:q...",
  "encoding": "bch-signed-message",
  "signature": "<base64_recoverable_signature>",
  "raw": {
    "ecdsa": "<base64>",
    "schnorr": "<base64>",
    "der": "<base64>"
  },
  "details": {
    "recoveryId": 1,
    "compressed": true,
    "messageHash": "<base64>"
  }
}
```

Recommended client payload:

```json
{
  "challenge_id": "chl_01hrxyz",
  "wallet_address": "bitcoincash:q...",
  "signature": "<base64_recoverable_signature>",
  "encoding": "bch-signed-message"
}
```

### 13.4 Verify endpoint

Endpoint:

- `POST /auth/verify`

Verification steps:

1. load challenge by `challenge_id`
2. confirm challenge exists, not expired, not already used
3. confirm submitted address matches stored normalized address
4. verify signature against stored message using the same scheme as `signed.ts`
5. mark challenge used
6. mint a short-lived session token

Success response:

```json
{
  "session_token": "<opaque_token>",
  "wallet_address": "bitcoincash:q...",
  "scopes": ["claim:submit"],
  "expires_at": 1770000900
}
```

### 13.5 Session token rules

Recommended:

- opaque random token or signed JWT
- lifetime `10-30m`
- bound to wallet address and event scope
- one wallet may have multiple concurrent event sessions

Claims endpoint should require:

- `Authorization: Bearer <session_token>`

### 13.6 Signature verification compatibility check

Before coding, explicitly confirm:

- whether `signed.ts` returns Electron Cash style base64 signatures for the chosen path
- whether backend verification will use recoverable signatures against cashaddr or explicit public key validation
- whether event addon auth needs mainnet and chipnet support from day one

Preferred outcome:

- use one wallet message-signing format consistently
- do not support multiple signature encodings in v1 unless required
- accept `encoding=bch-signed-message` as the only v1 signing format

## 14. Wallet Screen and Component Plan

This section maps the first event addon screens onto the existing OPTN Wallet structure.

### 14.1 Registration points

Files to update later:

- `OPTNWallet/src/addons/builtin/index.ts`
- `OPTNWallet/src/pages/apps/marketplaceScreenResolver.tsx`

New screen entry:

- addon id: `optn.builtin.events`
- app id: `eventRewardsApp`
- screen id: `EventRewardsApp`

### 14.2 Proposed wallet file layout

Recommended structure:

- `OPTNWallet/src/pages/apps/event-rewards/EventRewardsApp.tsx`
- `OPTNWallet/src/pages/apps/event-rewards/screens/MyEventsScreen.tsx`
- `OPTNWallet/src/pages/apps/event-rewards/screens/EventDetailScreen.tsx`
- `OPTNWallet/src/pages/apps/event-rewards/screens/ScanClaimScreen.tsx`
- `OPTNWallet/src/pages/apps/event-rewards/screens/RewardsScreen.tsx`
- `OPTNWallet/src/pages/apps/event-rewards/components/EventCard.tsx`
- `OPTNWallet/src/pages/apps/event-rewards/components/PassCard.tsx`
- `OPTNWallet/src/pages/apps/event-rewards/components/CampaignCard.tsx`
- `OPTNWallet/src/pages/apps/event-rewards/components/RewardList.tsx`
- `OPTNWallet/src/pages/apps/event-rewards/components/ClaimResultBanner.tsx`
- `OPTNWallet/src/pages/apps/event-rewards/hooks/useEventWalletInventory.ts`
- `OPTNWallet/src/pages/apps/event-rewards/hooks/useEventClaims.ts`
- `OPTNWallet/src/pages/apps/event-rewards/hooks/useEventAuth.ts`
- `OPTNWallet/src/pages/apps/event-rewards/hooks/useEventMetadata.ts`
- `OPTNWallet/src/pages/apps/event-rewards/services/eventApi.ts`
- `OPTNWallet/src/pages/apps/event-rewards/services/claimQr.ts`
- `OPTNWallet/src/pages/apps/event-rewards/types.ts`

### 14.3 Screen responsibilities

#### `EventRewardsApp.tsx`

Responsibilities:

- root state machine for selected event and active view
- wallet address selection if multiple addresses hold passes
- top-level loading and error handling

#### `MyEventsScreen.tsx`

Inputs:

- wallet token holdings
- event metadata lookup by pass category

Responsibilities:

- detect pass categories present in wallet
- map categories to event cards
- route into event details

#### `EventDetailScreen.tsx`

Inputs:

- selected event
- wallet holdings
- backend campaigns and claim history

Responsibilities:

- show pass summary
- show active sponsor/session campaigns
- show claim status
- deep-link into scan flow

#### `ScanClaimScreen.tsx`

Inputs:

- scanned QR payload
- authenticated wallet session token

Responsibilities:

- invoke scanner
- decode/validate QR structure
- fetch auth challenge
- sign message
- verify session
- submit claim
- poll result until completion or failure

#### `RewardsScreen.tsx`

Inputs:

- wallet holdings
- BCMR metadata
- backend reward metadata

Responsibilities:

- show sponsor tokens and badge NFTs grouped by event
- show redemption-ready rewards

### 14.4 Wallet data dependencies

Reuse existing wallet infrastructure where possible:

- `sdk.wallet.listAddresses()`
- `sdk.utxos.listForWallet()`
- wallet BCMR resolution path
- existing QR scanner patterns already used elsewhere in OPTN Wallet

### 14.5 UX rules

Use these simplifications:

- prefer event names over category IDs
- prefer sponsor names over token symbols
- always show claim status clearly: `ready`, `submitting`, `pending`, `received`, `failed`
- do not expose raw signing details in normal attendee flow

## 15. Minimal Backend Service Skeleton

The backend should start as one service with clear modules, not multiple deployables.

### 15.1 Suggested service layout

Recommended directories:

- `src/server`
- `src/routes/auth`
- `src/routes/events`
- `src/routes/claims`
- `src/routes/admin`
- `src/routes/sponsor`
- `src/services/auth`
- `src/services/tokenIndex`
- `src/services/claims`
- `src/services/issuance`
- `src/services/qr`
- `src/db`
- `src/jobs`

### 15.2 Core modules

#### Auth service

Responsibilities:

- normalize addresses
- create challenges
- verify signatures
- issue session tokens

#### TokenIndex client

Responsibilities:

- fetch pass holder eligibility
- fetch category holders for sponsors
- fetch BCMR metadata fallback

#### Claims service

Responsibilities:

- enforce campaign rules
- prevent duplicate claims
- write claim records
- hand off issuance jobs

#### Issuance service

Responsibilities:

- call existing BCH/CashTokens send or mint infra
- record txid
- retry failed jobs

#### Sponsor service

Responsibilities:

- sponsor-scoped campaign views
- sponsor category exports
- sponsor airdrop targeting

### 15.3 Minimal route set

Public:

- `POST /auth/challenge`
- `POST /auth/verify`
- `GET /events/by-pass/:category`
- `GET /events/:eventId`
- `GET /wallet/:lockingBytecode/events`
- `POST /claims/scan`
- `GET /claims/:claimId`

Sponsor:

- `GET /sponsor/events/:eventId/campaigns`
- `GET /sponsor/campaigns/:campaignId/claims`
- `GET /sponsor/categories/:category/holders`
- `POST /sponsor/campaigns/:campaignId/airdrops`

Organizer:

- `POST /admin/events`
- `POST /admin/events/:eventId/campaigns`
- `POST /admin/events/:eventId/claim-codes`
- `GET /admin/events/:eventId/claims`
- `POST /admin/events/:eventId/airdrops`

Internal:

- `POST /internal/issuance/reward`
- `POST /internal/issuance/airdrop`

### 15.4 Claim QR payload shape

For v1, use signed backend payloads encoded as QR text.

Suggested payload:

```json
{
  "v": 1,
  "kind": "claim",
  "event_id": "evt_demo_2026",
  "campaign_id": "camp_booth_1",
  "code_id": "code_123",
  "expires_at": 1770000300,
  "sig": "<backend_signature>"
}
```

Wallet checks:

- JSON parses
- version supported
- not obviously expired

Backend remains source of truth for signature validity.

### 15.5 First DB migration scope

Tables:

- `events`
- `event_passes`
- `sponsors`
- `campaigns`
- `claim_codes`
- `claims`
- `auth_challenges`
- `issuance_jobs`

Indexes:

- `claims(campaign_id, wallet_address)`
- `claims(campaign_id, wallet_locking_bytecode)`
- `campaigns(event_id, starts_at, ends_at)`
- `claim_codes(campaign_id, expires_at)`
- `auth_challenges(wallet_address, expires_at)`

### 15.6 Initial non-goals

Do not build in the first backend version:

- payment processing
- event ticket sales
- rotating QR infrastructure
- geofencing
- full sponsor CRM
- chat or attendee social graphs
