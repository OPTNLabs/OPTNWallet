// P2P CashFusion round transport over Nostr — Phase 4c. Binds the abstract
// RoundTransport (fusionSession.ts) to real relays.
//
// Round messages use STANDARD NIP-59 gift-wrap (kind 1059) — the same envelope as
// private chat DMs — so on the wire a fusion message is indistinguishable from any
// other encrypted DM. A custom kind would be a fingerprint ("this is a CashFusion
// round"); the standard envelope is not. This matches 00-Wallet's scheme.
//
// Collision with chat is avoided at the ADDRESSING layer, not the kind: fusion
// messages are gift-wrapped to a peer's EPHEMERAL round pubkey, while chat DMs go
// to the wallet's real NIP-06 identity — so the subscriptions
// ({kinds:[1059], #p:[roundKey]} vs {kinds:[1059], #p:[identityKey]}) never
// overlap. Gift-wrap layers (NIP-59): outer 1059 = random one-time author +
// scrambled timestamp (hides who/when); kind-13 seal = proves the real sender,
// encrypted; kind-14 rumor = the JSON round message.
//
// Unlinkability: OUTPUT registrations are sealed by a FRESH throwaway key, so even
// after the coordinator unwraps them it can't tie a peer's outputs to the inputs
// it registered under its round key. In production these also ride a fresh Tor
// circuit (torWebSocket).

import { SimplePool, generateSecretKey, type Event } from 'nostr-tools';
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip17';
import {
  parseRoundMessage,
  type RoundTransport,
} from './fusionSession';

/** NIP-59 gift-wrap. Same kind as chat; disambiguated by the #p recipient. */
export const GIFT_WRAP_KIND = 1059;

export interface RoundKeys {
  secretKey: Uint8Array;
  pubkey: string; // hex
}

/** A RoundTransport that carries fusion round messages as NIP-59 gift-wraps. */
export function createNostrRoundTransport(
  pool: SimplePool,
  relays: string[],
  round: RoundKeys,
  outputPool: SimplePool = pool
): RoundTransport {
  const protocolErrorHandlers = new Set<(from: string, error: Error) => void>();
  return {
    send: async (toPubkey, msg) => {
      // Outputs are sealed by a throwaway key (unlinkable); all else by the round key.
      const isAnonymousOutput = msg.type === 'outputs';
      const signer = isAnonymousOutput ? generateSecretKey() : round.secretKey;
      try {
        const wrapped = wrapEvent(
          signer,
          { publicKey: toPubkey },
          JSON.stringify(msg)
        );
        const publishingPool = isAnonymousOutput ? outputPool : pool;
        const settled = await Promise.allSettled(
          publishingPool.publish(relays, wrapped as Event)
        );
        if (!settled.some((result) => result.status === 'fulfilled')) {
          throw new Error('No Nostr relay accepted the Fusion message.');
        }
      } finally {
        if (isAnonymousOutput) signer.fill(0);
      }
    },

    onMessage: (handler) => {
      const sub = pool.subscribeMany(relays, { kinds: [GIFT_WRAP_KIND], '#p': [round.pubkey] }, {
        onevent(evt: Event) {
          try {
            const rumor = unwrapEvent(evt, round.secretKey);
            const msg = parseRoundMessage(rumor.content);
            if (!msg) {
              const error = new Error('Invalid or oversized Fusion round message.');
              protocolErrorHandlers.forEach((notify) =>
                notify(rumor.pubkey, error)
              );
              return;
            }
            handler(rumor.pubkey, msg);
          } catch {
            /* not addressed to us, or undecryptable — ignore */
          }
        },
      });
      return () => sub.close();
    },

    onProtocolError: (handler) => {
      protocolErrorHandlers.add(handler);
      return () => protocolErrorHandlers.delete(handler);
    },
  };
}
