# Proposed blame for P2P CashFusion

Status: **Stage 1 implemented in the running wallet; later stages not started**  
Protocol baseline: P2P CashFusion v4

Silent no-sign cannot be honestly attributed on asynchronous Tor/Nostr.
Absence looks the same as a drop, partition, crash, or withhold. This plan
does not claim to name a silent signer.

## 1. Stage 1 — mandatory for safe blame

This is the only code required to make the existing blame boundary safe.

- Generic abort never requests or triggers `component_disclosure`.
- Delete `invalid_signature_set` entirely as missing-signature blame.
- Coordinator receipt state is never evidence of non-sending.
- Named blame requires positive, independently re-verifiable evidence that
  does not depend on an abort-forced identity opening.
- Missing signature becomes `ambiguous_signature_timeout`; no accused peer.

Keep blame only for hard crypto faults already in v4: Pedersen imbalance,
credential slot out of range, forged/invalid opening, bad component
commitment, duplicate outpoint.

## 2. Padded signature fanout — v5 only

- v5 exists only if full-cover fanout meets the measured Tor deadline under
  loss.
- Fixed global send count `K`, fixed sizes and schedule, identical retries,
  indistinguishable dummies, fresh key and circuit per envelope.
- If the budget fails, do not ship v5 or unpadded fanout; remain on
  corrected v4.
- Fanout improves completion against a withholding coordinator. It does not
  attribute silence.
- The coordinator still gathers, issues credentials, assembles the template,
  and receives onion outputs.

Unpadded fanout is an explicit input-cardinality traffic tradeoff. Do not
advertise it as preserving that unlinkability.

## 3. Quarantine — deferred, default off

Keep it out of the first implementation. Revisit only if Chipnet shows
repeated same-outpoint disruption.

If enabled later: this device may exclude that outpoint from **local P2P
Fusion admission** only. Never lock spending, server Fusion, other wallets,
or a shared list. Only after a frozen template, exhausted deadline, and the
observer independently missing that signature. Not because the coordinator
aborted. Wipe the record if a valid signature later arrives.

## 4. Rejected

No locked box, threshold opening, ZKP-as-proof-of-silence, identity or
reputation, bonds, adaptors, or checker-only group reveal in this plan.
(Checker-only reveal is a separate topic for invalid cryptographic proofs,
not missing signatures.)

## Boundary

A successful round stays as today: anonymous inputs, onion outputs, peeler
unnamed. A dead round still does not rewrite the transaction or drop a
missing signer.

Coordinator-framing attack (honest signature sent, coordinator drops it,
aborts, demands disclosure, claims missing): Stage 1 means the signer
reveals nothing, the accusation is rejected, the round ends ambiguously.
With a budget-passing v5 fanout, other peers may still complete the exact
transaction. Without fanout, they retry with nobody named.
