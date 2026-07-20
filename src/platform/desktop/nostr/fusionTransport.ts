// P2P CashFusion round transport over Nostr — Phase 4c. Binds the abstract
// RoundTransport (fusionSession.ts) to real relays.
//
// Each round message is NIP-44 encrypted to the recipient's ephemeral round
// pubkey and published as a kind-22231 event — a DEDICATED kind, distinct from
// chat's gift-wrap (kind 1059), so fusion traffic never surfaces in the chat
// inbox and vice-versa. The recipient subscribes to kind 22231 tagged to its
// round pubkey and decrypts with (its round key ↔ the event author's key).
//
// Unlinkability: OUTPUT registrations are signed by a FRESH throwaway key per
// message (not the round key), so neither the coordinator nor a relay can tie a
// peer's outputs back to the inputs it registered under its round identity. In
// production these output messages should also travel over a fresh Tor circuit
// for IP-level unlinkability; that network-layer hardening (routing the relay
// WSS through the app's Tor SOCKS proxy) is tracked separately — the crypto-layer
// unlinkability (ephemeral keys + NIP-44) is implemented here.

import { SimplePool, finalizeEvent, generateSecretKey, nip44, type Event } from 'nostr-tools';
import { ROUND_MESSAGE_KIND } from './fusion';
import type { RoundMessage, RoundTransport } from './fusionSession';

export interface RoundKeys {
  secretKey: Uint8Array;
  pubkey: string; // hex
}

/** A RoundTransport that carries fusion round messages over Nostr relays. */
export function createNostrRoundTransport(
  pool: SimplePool,
  relays: string[],
  round: RoundKeys
): RoundTransport {
  return {
    send: async (toPubkey, msg) => {
      // Outputs go from a throwaway key (unlinkable); all else from the round key.
      const signer = msg.type === 'outputs' ? generateSecretKey() : round.secretKey;
      const convKey = nip44.getConversationKey(signer, toPubkey);
      const content = nip44.encrypt(JSON.stringify(msg), convKey);
      const evt = finalizeEvent(
        {
          kind: ROUND_MESSAGE_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', toPubkey]],
          content,
        },
        signer
      );
      await Promise.allSettled(pool.publish(relays, evt));
    },

    onMessage: (handler) => {
      const sub = pool.subscribeMany(relays, { kinds: [ROUND_MESSAGE_KIND], '#p': [round.pubkey] }, {
        onevent(evt: Event) {
          try {
            const convKey = nip44.getConversationKey(round.secretKey, evt.pubkey);
            const msg = JSON.parse(nip44.decrypt(evt.content, convKey)) as RoundMessage;
            handler(evt.pubkey, msg);
          } catch {
            /* not addressed to us, or undecryptable — ignore */
          }
        },
      });
      return () => sub.close();
    },
  };
}
