# P2P CashFusion Threat Model

This document covers the threat model for OPTN Wallet's **shipped** P2P
CashFusion implementation (PR #12), including protocol-level threats, Tor
transport, and key management. It is written for auditors, contributors, and
future maintainers.

**Privacy component map (names and roles):** see
[p2p-cashfusion-privacy-layers.md](./p2p-cashfusion-privacy-layers.md) for the
PR #12 **implemented** stack: **Tor**, **NIP-59 gift-wrap**, **Pedersen**,
**blind Schnorr credentials**, and **output onion** (peer peel chain — *not* Tor).

**Ship status map:** [cashfusion-implementation-scope.md](./cashfusion-implementation-scope.md).

## Adversary Classes

### A1: Malicious Coordinator

The coordinator is elected deterministically from the participant set via
`electCoordinator(pubkeys)`. Any participant can be the coordinator for a
given round. The coordinator:

- Assembles the transaction template (input→output mapping)
- Collects blind signature requests and returns blind signatures
- Broadcasts the final transaction

**What the coordinator learns:**
- The full input→output mapping (which inputs fund which outputs)
- The participant list (pubkeys)
- The tier, epoch, and network

**What the coordinator cannot do:**
- Sign other participants' inputs (private keys never leave the wallet)
- Forge blind signatures (the signer's key is ephemeral per round)
- Modify the template after participants have verified it (each peer runs
  full BCH VM validation before signing)

**Mitigation:**
- Coordinator election is set-bound: `H(sorted pubkeys | candidate)`,
  preventing offline key grinding
- Every participant verifies the assembled template byte-for-byte via BCH
  VM execution before signing
- Broadcast liveness: any participant can broadcast, not just the coordinator

### A2: Malicious Peer

A peer participating in the same round but acting dishonestly.

**What a malicious peer learns:**
- After assembly: the full template (all inputs and outputs in plaintext)
- Its own blind credentials
- If it is a peeler hop: onion batches it is allowed to peel (see A2b)

**What a malicious peer cannot do:**
- Sign other participants' inputs
- Extract private keys from the signing process
- Reliably map which peer *contributed* which **output** when **output onion**
  is on and at least one hop is honest (each hop shuffles before forward)
- Map inputs to origin peer from assembly order alone (inputs sorted by
  `txid:index`, not by submitter)

**Mitigation:**
- **Output onion** (always on): peel → CSPRNG shuffle → forward
  (`onionCrypto.ts` / `fusionSession.ts`)
- Each participant submits with 200–2000 ms jitter
- Inputs sorted by `(txid, index)` before assembly
- Duplicate input detection prevents a wallet meeting itself in a pool
- **Privacy-preserving blame** (`fusionBlame.ts`): on *received* messages that
  fail a hard crypto/structural check (bad credential, unbalanced Pedersen,
  duplicate outpoint, bad sig set), peers broadcast a verifiable `blame` bound
  to the **ephemeral session pubkey** only, then abort. Peers re-verify evidence
  before acting (anti-frame). **Timeouts, relay ACK failures, late join, and
  missing messages are never blame** — honest poor-network peers must not be
  scapegoated. Not a permanent identity ban (throwaway keys).

### A2b: Intermediate output-onion peeler

**Not Tor.** This is the peer peel chain for **outputs only**.

**What an intermediate peeler learns:**
- Ciphertext (or after its peel, inner layers) for the batch it handles
- Timing of when blobs arrive at that hop

**What it cannot do (if ≥1 honest hop shuffled):**
- Point at a peer and say “that output is yours” from batch order alone

**What the last peeler learns:**
- Full plaintext **output list** after the final peel (then sends it to the
  coordinator). Unlinkability, not secrecy from the last hop — see
  `onionCrypto.ts` header comment.

**Infrastructure:** none beyond peers already in the round.

### A3: Nostr Relay Operator

The relay stores pool announcements (replaceable kind 12230 events) and
routes gift-wrapped P2P events between participants.

**What the relay learns:**
- Pool announcements (ephemeral pubkey, network, tiers, numInputs) — public metadata
- Encrypted gift-wrap envelopes (kind 1059) for round traffic — **not** plaintext
  proposals / inputs / outputs / signatures when NIP-59 is used correctly
- Clearnet IP of the connecting client **unless** the client uses Tor

**What the relay cannot do:**
- Read gift-wrapped round bodies (NIP-59)
- See the wallet’s clearnet IP when Tor is required (P2P fail-closed)
- Modify events in transit without failing Nostr signature checks
- Link rounds via a stable identity (fresh secp256k1 keypair per attempt)

**Mitigation:**
- **NIP-59 gift-wrap** for round messages (`fusionTransport.ts`)
- **Tor** for all remote P2P sockets (mandatory)
- Fresh identity per fusion attempt
- REPLACEABLE announce kind; short TTL on pool announcements

### A4: Network Observer / Chain Analyst

A passive observer watching network traffic or analyzing the blockchain.

**What the observer learns:**
- Transaction structure (inputs, outputs, amounts) after confirmation
- Timing of Tor circuit creation (if correlated with fusion rounds)

**What the observer cannot do:**
- Link inputs to specific participants (blind signatures + per-component
  submission with jitter)
- Determine the tier from fee structure (quantization grid + fee fuzz)
- Correlate rounds across sessions (fresh identity per attempt)

**Mitigation:**
- Output quantization: log-scale grid rounds values to reduce tier
  fingerprinting (see `fusionP2pAllocation.ts`)
- Fee fuzz: capped at 0.5% or 500 sats to prevent exact fee matching
- Per-component submission with 200–2000 ms random jitter prevents
  timing-based component→participant linkage
- Broadcast liveness with 2–8 s jitter prevents coordinator-only
  broadcast correlation

### A5: Compromised Tor Process

If the integrated Tor binary or system Tor is compromised.

**Impact:**
- All fusion traffic is deanonymized (IP addresses visible to attacker)
- Blame proofs may be intercepted (encrypted to communication keys, but
  the attacker can relay them)

**Mitigation:**
- System Tor is preferred over built-in Tor (reduces attack surface)
- Blame proofs are ECDH-encrypted to per-component communication keys —
  a Tor-level attacker cannot decrypt them
- The integrated Tor process is sandboxed and only has access to the
  SOCKS5 port

## Cryptographic Primitives

Layer roles (what each is *for*): [p2p-cashfusion-privacy-layers.md](./p2p-cashfusion-privacy-layers.md).

### BCH Schnorr Signatures

**Used for:** Transaction input signing, blind signature scheme

**Implementation:** `src-tauri/src/fusion/schnorr.rs`

**Properties:**
- Challenge: `e = sha256(R.x || compressed(P) || msg32)`
- Verification: `R = s*G - e*P`, checks `R.x` matches and `jacobi(R.y) = +1`
- Jacobi rule: only `R.x` travels; verifier reconstructs the unique `R`
  whose `y` is a quadratic residue

**Wire format:** `R.x(32) || s(32)` — 64 bytes

**Compatibility:** Byte-for-byte compatible with Electron Cash
(`electroncash/schnorr.py`). Verified by round-trip tests.

### Blind Schnorr Signatures

**Used for:** Component-to-signature unlinkability

**Implementation:** `BlindSignatureRequest` in `schnorr.rs`

**Flow:**
1. Requester picks random `a, b`; computes `R' = c*(R + a*G + b*P)`
2. Challenge: `e' = sha256(R'.x || compressed(P) || msg)`, then `e = (c*e' + b) mod n`
3. Signer returns `s = k + e*x`
4. Unblind: `s' = c*(s + a) mod n`
5. Result: `(R'.x, s')` — valid BCH Schnorr signature under `P`

**Security:** The signer never sees `(R'.x, s')`, so it cannot link the
request to the final signature.

### Pedersen Commitments

**Used for:** Hiding component amounts while allowing homomorphic balance
verification

**Implementation:** `src-tauri/src/fusion/pedersen.rs`

**Commitment:** `commit(amount, nonce) = amount*H + nonce*G`

**H generator:** Nothing-up-my-sleeve point `0x02 || "CashFusion gives us
fungibility."` — 33-byte compressed encoding of a point with unknown
discrete log vs G.

**Homomorphism:** `commit(a1, n1) + commit(a2, n2) = commit(a1+a2, n1+n2)`

**Wire format:** 65-byte uncompressed point (`0x04` prefix)

**Nonce generation:** Rejection-sampled from OS CSPRNG, explicitly rejects
zero (a zero nonce would expose `amount*H` directly).

### Output onion (peer peel chain — not Tor)

**Used for:** Contributor→output unlinkability among **peers** during the
output collection phase (always on; no direct path).

**Implementation:** `src/platform/desktop/nostr/onionCrypto.ts`, peel/forward
in `fusionSession.ts`.

**Property:** Each hop peels one ECDH+AES-GCM layer, shuffles the batch with
CSPRNG Fisher–Yates, and forwards. One honest hop breaks order-based linking.
The last peeler *does* see all outputs in plaintext; the coordinator sees them
for assembly (classic fusion-server class of visibility).

**Not used for:** IP privacy (that is Tor), relay content privacy (that is
NIP-59), or credential issuance (that is Pedersen + blind Schnorr).

### ECDH Encryption (Blame Proofs)

**Used for:** Encrypting blame proofs to specific participants

**Implementation:** `src-tauri/src/fusion/encrypt.rs`

**Scheme:** ECIES with:
- ECDH: `key = sha256(compressed(privkey * recipient_pubkey))`
- AES-256-CBC (IV=0, ephemeral keypair ensures different key per encryption)
- HMAC-SHA256 truncated to 16 bytes

**Wire format:** `ephemeral_pubkey(33) || ciphertext || mac(16)`

**Padding:** Fixed-length padding hides actual message length from relay.

## Protocol-Level Threats

### Replay Attacks

**Threat:** An attacker replays old messages from a completed round into a
new round.

**Mitigation:**
- Every message includes `MessageBinding` with `version`, `nonce`, and
  `timestamp`
- Fresh nonce per message (16-byte hex from `crypto.getRandomValues`)
- Message age window: 300 seconds, with 30-second clock skew tolerance
- Duplicate nonce tracking: `seenNonces` Set prevents reuse within a window
- Session ID: 32 random bytes, included in every round message

### Cross-Round Injection

**Threat:** An attacker injects messages from one round into another.

**Mitigation:**
- `MessageBinding` includes `version` (protocol version), `nonce`, and
  `timestamp`
- Each message is bound to a specific round via `session` ID
- `round_proposal` and `round_start` include the full participant list,
  network, tier, and epoch — all checked before acceptance

### Sybil Attacks

**Threat:** An attacker creates many identities to win coordinator election
more often.

**Acknowledged limitation:** No Sybil resistance. An attacker with N of M
identities coordinates roughly N/M of rounds. This is a fundamental trade-off
of the P2P design — a trusted coordinator would solve it but reintroduces
the centralization that P2P fusion avoids.

**Partial mitigation:**
- Coordinator election is set-bound (depends on full candidate set)
- Grinding must happen inside the round window, after the set is known
- The set changes when any participant joins or leaves

### Eclipse Attacks

**Threat:** An attacker controls all relay connections to a victim, preventing
them from discovering honest peers.

**Mitigation:**
- Multiple relays can be configured (stored in `nostrRelays` array)
- Pool announcements are published to all configured relays
- Ghost detection: if the elected coordinator doesn't propose within 3.5s,
  failover drops it and re-elects

### Timing Attacks

**Threat:** An attacker correlates submission timing to identify which peer
submitted which components.

**Mitigation:**
- Per-component submission with 200–2000 ms random jitter
- Components sent via separate Nostr messages (not batched)
- Fresh Tor circuit per component batch (in the server-based path)
- Broadcast liveness adds 2–8 s jitter before broadcasting

### Denial of Service

**Threat:** An attacker prevents fusion rounds from completing.

**Mitigation:**
- Max 20 participants per round, max 100 components
- Message size limit: 64KB
- Coordinator failover: up to 8 silent coordinators before round failure
- Timeout: 120 seconds prevents indefinite hangs
- Duplicate input detection prevents a wallet meeting itself

**Blame is NOT a DoS mitigation.** It is fail-fast, provable diagnosis on
abort: peers learn *that* a round broke and *which rule* broke it, with
evidence, instead of hanging to the 120-second timeout. It does not stop a
griefer. The accused is an ephemeral round key that is destroyed when the
round ends, so the same attacker returns as a fresh, unrecognisable key on the
next attempt. `recordBlamedSessionKey` keeps a blamed key out of the local
gather for 10 minutes (`fusionRoundState.ts`), but that key is already dead
and the record is never shared with other peers — it is not a ban and must not
be counted as one.

Electron Cash is no better here: its server kills the offending client
mid-round and restarts, and caps *simultaneous* fuses per IP
(`ip_max_simul_fuse = 3`); it implements no ban list. We do not even have that
cap, because a peer coordinator over Nostr + Tor never sees an IP. Durable
exclusion would need Sybil resistance (cost, stake, or reputation), which is
out of scope for this protocol.

## Key Management

### Session Keys

- Fresh secp256k1 keypair per fusion attempt (`generateSecretKey()`)
- Used only for Nostr event signing
- Never reused across rounds
- Discarded after round completion

### Communication Keys

- Per-component keypair generated during round setup (`gen_keypair()`)
- Public key sent in `InitialCommitment`
- Used for ECDH encryption of blame proofs
- Private key stored for decrypting incoming proofs

### Signing Keys

- Derived from the wallet's HD key derivation (BIP44)
- Never leave the wallet
- Used only for signing own inputs via BCH Schnorr

### Ciphertext Key Model (Desktop + Extension)

The wallet uses a ciphertext model for key management. The derived CryptoKey
**never persists in RAM**. Instead:

1. The user's password + KDF salt are cached in `WalletKeyCache`
2. On each encrypt/decrypt or signing operation, the CryptoKey is re-derived
   via PBKDF2 (600k iterations, SHA-256), used, and immediately discarded
3. The key exists only for the duration of the operation (ms), not between
   operations

**Desktop:** The salt is stored in the OS keychain (Windows Hello / macOS
Keychain). An attacker with RAM access gets the password but cannot derive
the key without the salt from the keychain — two separate storage layers
must be compromised.

**Browser Extension:** The salt is in localStorage (extension-scoped origin).
The ciphertext model still helps: the key is ephemeral, so an attacker dumping
RAM between operations gets only ciphertext + password, not a usable key.

**Performance trade-off:** PBKDF2 runs on each crypto operation. This adds
~200-500ms per encrypt/decrypt call. The security benefit (ephemeral key)
outweighs the cost for a wallet application.

### Spending Re-Auth Gate (Desktop)

When auto-lock is set to "Never" (0), the wallet re-prompts for the password
before any spending operation (`fetchAddressPrivateKey` with `spending: true`).
This matches Electron Cash's `@protected` decorator model: the password gates
the signing path, not just the unlock.

**Scope:**
- Spending: manual sends (TransactionBuilderHelper, useTransactionHandlers,
  WalletConnect signing, AddonsSDK `signatureTemplateForAddress`)
- Exempt: auto-fusion (user consented), address derivation, balance checks,
  message signing

**Cache:** After a successful spend auth, subsequent spend ops within 10 minutes
pass without re-prompting. The timer resets on each successful auth. This covers
batched signing (multi-input transactions) and rapid sequential sends. After the
window expires, the next spend re-prompts.

**Why 10 minutes:** Long enough for batched operations and rapid sequential
sends. Short enough that an attacker cannot chain sends after the user walks
away for an extended period. The cache is cleared on wallet lock.

**Not active for other auto-lock settings:** When auto-lock is set to 1/5/15/30/60/120/240 min, the
inactivity timer handles session protection. The spending re-auth gate is
redundant in those cases and would only add friction.

### Tor Identity

- Fresh Tor circuit per session (integrated Tor generates new circuits)
- System Tor preferred over built-in Tor
- `ensureTorAvailable()` runs once per window open: checks system Tor
  first (9050/9150), starts built-in as fallback

## On-Chain Privacy

### Tier Fingerprinting

**Risk:** A chain analyst could infer which tier a fusion round used by
analyzing output value patterns.

**Mitigation:**
- Log-scale quantization grid: output values are rounded to grid points
  that vary by tier, making different tiers look similar on-chain
- Fee fuzz: small random noise (capped at 0.5% or 500 sats) prevents
  exact fee-based tier inference
- Output count: 2–4 per peer (randomly selected)

### Input→Output Linkage

**Risk:** A chain analyst could link inputs to outputs in a fusion tx.

**Mitigation:**
- SIGHASH_ALL|FORKID: each peer's preimage commits to all outpoints,
  all outputs, and its own scriptCode+value — but not other peers'
  prevout scripts
- Inputs are sorted by `(txid, index)` — origin is hidden
- Pedersen commitments hide individual amounts during the round

### Cross-Round Linkability

**Risk:** An analyst links outputs from different rounds to the same wallet.

**Mitigation:**
- Fresh address per output (HD derivation)
- Fresh Nostr identity per round
- No persistent identifiers across rounds

## Known Trade-offs

| Trade-off | Decision | Rationale |
|---|---|---|
| Coordinator learns input→output mapping | Accepted | Fundamental to P2P design; no trusted third party |
| No Sybil resistance | Accepted | Would require PoW or stake, adding complexity and centralizing |
| No SIGHASH_UTXOS | Accepted | Each peer sees all outpoints/outputs during assembly; SIGHASH_UTXOS would require protocol changes |
| Blinding unlinkability is informal | Acknowledged | Test verifies `R'.x ≠ R.x`; formal proof is future work |
| FNV-1a for election | Accepted | Non-cryptographic hash; adequate for set-bound election inside round window |
| Built-in Tor as fallback | Accepted | Reduces privacy if system Tor unavailable; system Tor preferred |
| Output onion last peeler sees all outputs | Accepted | Unlinkability via shuffle hops, not secrecy from final hop / coordinator |
| Coordinator learns full template | Accepted | Same class as classic fusion server; every peer still verifies before signing |

## References

- [CashFusion Security Audit (Nagravision, 2020)](https://electroncash.org/fusionaudit.pdf)
- [Electron Cash schnorr.py](https://github.com/Electron-Cash/Electron-Cash/blob/master/electroncash/schnorr.py)
- [Electron Cash pedersen.py](https://github.com/Electron-Cash/Electron-Cash/blob/master/electroncash_plugins/fusion/pedersen.py)
- [Electron Cash protocol.py](https://github.com/Electron-Cash/Electron-Cash/blob/master/electroncash_plugins/fusion/protocol.py)
- [BCH Schnorr specification](https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/2019-05-15-schnorr.md)
