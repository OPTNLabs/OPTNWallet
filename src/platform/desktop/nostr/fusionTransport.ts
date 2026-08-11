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

import {
  SimplePool,
  generateSecretKey,
  getPublicKey,
  type Event,
} from 'nostr-tools';
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip17';
import { PUBLISH_RELAY_TIMEOUT_MS, publishEventAtLeastOnce } from './fusion';
import { parseRoundMessage, type RoundTransport } from './fusionSession';

/** NIP-59 gift-wrap. Same kind as chat; disambiguated by the #p recipient. */
export const GIFT_WRAP_KIND = 1059;

/**
 * Grace period before a one-shot component socket is closed, so relays beyond
 * the first ACK still receive the event. Long enough for slow Tor circuits,
 * short enough that the socket is not reusable for a later component.
 */
export const ONE_SHOT_POOL_LINGER_MS = PUBLISH_RELAY_TIMEOUT_MS + 2_000;

/**
 * Same-origin bridge for round messages (multi-wallet on one machine).
 * Remote peers still use Nostr gift-wrap only — BC never leaves this origin.
 * Live auto often failed at ACK because Tor gift-wraps dropped while all
 * windows already shared pool discovery via BC.
 */
const ROUND_BC_NAME = 'optn-p2p-round-v1';

export interface RoundKeys {
  secretKey: Uint8Array;
  pubkey: string; // hex
}

/** A RoundTransport that carries fusion round messages as NIP-59 gift-wraps. */
export function createNostrRoundTransport(
  pool: SimplePool,
  relays: string[],
  round: RoundKeys,
  outputPool: SimplePool = pool,
  signal?: AbortSignal,
  /**
   * Makes a short-lived pool for ONE anonymous component publish.
   *
   * A fresh throwaway signing key stops the coordinator tying an output to a
   * peer's round identity, but it does nothing about the transport: when every
   * output of a round leaves over the same `outputPool` socket, the relay can
   * group them by connection and the fresh keys buy nothing against that
   * observer. One pool per component means one WebSocket — and, in production
   * where the Tor implementation is installed globally, one fresh circuit with
   * its own SOCKS isolation token.
   *
   * Omitted (tests, same-origin runs) it falls back to the shared outputPool,
   * which is the previous behaviour.
   */
  createComponentPool?: () => SimplePool
): RoundTransport {
  const protocolErrorHandlers = new Set<(from: string, error: Error) => void>();
  /** Dedup BC+Nostr dual path (same msg.nonce once). */
  const seenMsgNonces = new Set<string>();
  const deliver = (
    from: string,
    msg: Parameters<Parameters<RoundTransport['onMessage']>[0]>[1],
    handler: Parameters<RoundTransport['onMessage']>[0]
  ) => {
    const nonce =
      msg && typeof msg === 'object' && 'nonce' in msg
        ? String((msg as { nonce?: string }).nonce ?? '')
        : '';
    if (nonce) {
      if (seenMsgNonces.has(nonce)) return;
      seenMsgNonces.add(nonce);
      if (seenMsgNonces.size > 2_000) {
        // Bound memory for long rounds.
        seenMsgNonces.clear();
      }
    }
    handler(from, msg);
  };
  return {
    send: async (toPubkey, msg) => {
      // Outputs (plain or onion) are sealed by a throwaway key so the recipient
      // cannot tie them to our round identity. onion_output was previously
      // signed with the round key, undoing the unlinkability onion bought.
      // Every transaction COMPONENT is anonymous; only the control plane
      // (round_ack, credential_request/response, onion_declare,
      // components_ready, assembled, final, abort) keeps the round identity.
      // Signatures are included deliberately: anonymising input registration
      // and then letting one peer send signatures for X, Y and Z under its
      // round key would re-group exactly what was just separated.
      const isAnonymousOutput =
        msg.type === 'outputs' ||
        msg.type === 'onion_output' ||
        msg.type === 'inputs' ||
        msg.type === 'signature';
      const signer = isAnonymousOutput ? generateSecretKey() : round.secretKey;
      // Same-origin dual path first (fast local multi-wallet). Always also
      // publish Nostr so remote peers still work.
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          const bc = new BroadcastChannel(ROUND_BC_NAME);
          // Match gift-wrap identity: anonymous outputs use a throwaway from.
          const fromBc = isAnonymousOutput
            ? getPublicKey(signer)
            : round.pubkey;
          bc.postMessage({
            to: toPubkey,
            from: fromBc,
            msg,
          });
          bc.close();
        }
      } catch {
        /* ignore BC failures */
      }
      // One socket per anonymous component. Built before the publish so the
      // `finally` can always close it, even if wrapping throws.
      const oneShotPool = isAnonymousOutput
        ? createComponentPool?.() ?? null
        : null;
      try {
        const wrapped = wrapEvent(
          signer,
          { publicKey: toPubkey },
          JSON.stringify(msg)
        );
        const publishingPool =
          oneShotPool ?? (isAnonymousOutput ? outputPool : pool);
        await publishEventAtLeastOnce(
          publishingPool,
          relays,
          wrapped as Event,
          signal
        );
      } finally {
        if (isAnonymousOutput) signer.fill(0);
        // Drop the socket (and with it the Tor circuit) so no later component
        // can be observed reusing it.
        //
        // Deferred, NOT immediate. publishEventAtLeastOnce resolves on the
        // FIRST relay ACK (minAcks = 1), while the remaining relays are still
        // being written. Closing synchronously would cut those off, and a peer
        // subscribed only to one of them would never receive the blob — the
        // round then aborts with anonBatches=0. The old shared pool stayed open
        // so propagation finished in the background; this preserves that while
        // still retiring the socket.
        if (oneShotPool) {
          const pending = oneShotPool;
          setTimeout(() => {
            try {
              pending.close(relays);
            } catch {
              /* already closed */
            }
          }, ONE_SHOT_POOL_LINGER_MS);
        }
      }
    },

    onMessage: (handler) => {
      // onion_output / outputs publish via outputPool (fresh Tor isolation).
      // Subscribe both pools so a circuit that only lands on the output sockets
      // still delivers hop blobs to peelers (missed hops → outputSlots=0).
      const filter = { kinds: [GIFT_WRAP_KIND], '#p': [round.pubkey] };
      const onEvent = (evt: Event) => {
        try {
          const rumor = unwrapEvent(evt, round.secretKey);
          const msg = parseRoundMessage(rumor.content);
          if (!msg) {
            const error = new Error(
              'Invalid or oversized Fusion round message.'
            );
            protocolErrorHandlers.forEach((notify) =>
              notify(rumor.pubkey, error)
            );
            return;
          }
          deliver(rumor.pubkey, msg, handler);
        } catch {
          /* not addressed to us, or undecryptable — ignore */
        }
      };
      const sub = pool.subscribeMany(relays, filter, { onevent: onEvent });
      const outputSub =
        outputPool === pool
          ? null
          : outputPool.subscribeMany(relays, filter, { onevent: onEvent });

      let bc: BroadcastChannel | null = null;
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          bc = new BroadcastChannel(ROUND_BC_NAME);
          bc.onmessage = (ev: MessageEvent) => {
            const data = ev.data as {
              to?: string;
              from?: string;
              msg?: unknown;
            } | null;
            if (!data || data.to !== round.pubkey) return;
            if (typeof data.from !== 'string' || data.from.length < 32) return;
            const content =
              typeof data.msg === 'string'
                ? data.msg
                : JSON.stringify(data.msg ?? null);
            const parsed = parseRoundMessage(content);
            if (!parsed) return;
            deliver(data.from, parsed, handler);
          };
        }
      } catch {
        bc = null;
      }

      return () => {
        sub.close();
        outputSub?.close();
        try {
          bc?.close();
        } catch {
          /* ignore */
        }
      };
    },

    onProtocolError: (handler) => {
      protocolErrorHandlers.add(handler);
      return () => protocolErrorHandlers.delete(handler);
    },
  };
}
