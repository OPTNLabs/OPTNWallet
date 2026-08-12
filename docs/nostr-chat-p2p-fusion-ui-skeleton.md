# Nostr chat and P2P CashFusion UI skeleton

## Shipped scope

- A first-class Chat route with responsive inbox and conversation panes.
- A local setup conversation that explains the private-message activation flow.
- Nostr identity and relay-pool settings, including preview-only custom relay drafts.
- A P2P CashFusion-over-Nostr readiness panel inside CashFusion settings.

This checkpoint is intentionally non-operational. It creates no Nostr key,
opens no WebSocket, publishes no event, and cannot start or authorize a fusion
round. Disabled actions state this directly in the UI.

## Interaction model

The Chat route uses a two-pane layout on desktop and a drill-in conversation on
small screens. The only initial item is a local setup assistant, so the product
does not fabricate contacts or network messages. Nostr settings separate identity
from relay configuration. CashFusion settings keep P2P transport readiness beside
the existing execution safety gate.

## Protocol boundary for the next phase

- Chat: unsigned kind-14 rumor, kind-13 seal, and per-recipient kind-1059 gift wrap.
- Encryption: audited NIP-44 v2 implementation and official vectors; no hand-rolled crypto.
- Relays: NIP-65 for general discovery and kind 10050 for private-message relays.
- Verification: validate wrapper, seal, rumor ID, signatures, recipient, and matching
  seal/rumor pubkeys before displaying content.
- Identity: never reuse the BCH seed or spending keys as Nostr transport keys.
- P2P Fusion: versioned application messages with network, round, phase, sequence,
  nonce, expiry, and payload commitments. Relay `OK` is not peer delivery.
- Spend safety: Nostr messages can coordinate but never authorize BCH signing.
