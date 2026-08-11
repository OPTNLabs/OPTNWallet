import { generateSecretKey } from 'nostr-tools';

import { binToHex } from '../../../utils/hex';
import {
  P2P_PROPOSAL_TIMEOUT_MS,
  P2P_RENDEZVOUS_MS,
  P2P_RENDEZVOUS_RESEND_MS,
} from '../fusionTiming';
import {
  electCoordinator,
  MIN_PARTICIPANTS,
  type FusionPoolNetwork,
} from './fusion';
import { messageBinding, type RoundMessage, type RoundTransport } from './fusionSession';

const MAX_PARTICIPANTS = 8;
const DEFAULT_RENDEZVOUS_TIMEOUT_MS = P2P_RENDEZVOUS_MS;
const DEFAULT_PROPOSAL_TIMEOUT_MS = P2P_PROPOSAL_TIMEOUT_MS;
const PUBKEY = /^[0-9a-f]{64}$/;
const SESSION = /^[0-9a-f]{64}$/;

/** User-facing hint for split pools / late joiners (evidence: 3 fused, 1 timed out). */
export const RENDEZVOUS_LATE_JOINER_HINT =
  'Other wallets may have already formed a round without you ' +
  '(you were late or Tor was slow). Auto will retry shortly; ' +
  'Manual Start can try again when peers are online.';

export interface FusionRendezvousParams {
  myPubkey: string;
  candidates: string[];
  network: FusionPoolNetwork;
  tier: number;
  epoch: number;
  timeoutMs?: number;
  /** Test seam; production allows a five-second lower-coordinator window. */
  coordinatorSettleMs?: number;
  /**
   * How long a participant waits for the elected coordinator's FIRST proposal
   * before writing it off as a ghost. A live coordinator proposes immediately
   * (and keeps re-offering), so this stays short — it is the failover trigger,
   * not the round budget.
   */
  proposalTimeoutMs?: number;
  sessionFactory?: () => string;
  signal?: AbortSignal;
}

export interface NegotiatedFusionRound {
  session: string;
  coordinator: string;
  participants: string[];
  network: FusionPoolNetwork;
  tier: number;
  epoch: number;
}

function canonicalParticipants(candidates: string[]): string[] {
  return [...new Set(candidates.filter((pubkey) => PUBKEY.test(pubkey)))]
    .sort()
    .slice(0, MAX_PARTICIPANTS);
}

function sameParticipants(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((pubkey, index) => pubkey === b[index]);
}

/**
 * Does `from`'s proposal outrank the round we are currently holding?
 *
 * Partial relay views mean two peers can each legitimately coordinate their own
 * candidate set, and the round splits unless both answer this identically. Both
 * hold both participant lists by the time they ask, so both derive the same
 * union and run the same election over it — that is what makes it converge.
 *
 * Neither reference implementation solves this. Electron Cash has no election
 * at all (a known server coordinates, conf.py:166). 00-Wallet takes the lowest
 * pubkey and, when two views disagree, simply waits for a round_start that
 * never comes (landing/views/fusion.ts:345).
 *
 * Ranking by participant COUNT was the tempting alternative — it yields bigger
 * rounds and nobody is dropped. It is rejected because the count is self-
 * reported: padding your claimed candidate list is free, which would re-open
 * the grinding vector that binding the election to the candidate set closed.
 * Whoever coordinates learns the input→output mapping, so that is not a cost
 * worth paying for a larger round.
 */
function outranks(
  from: string,
  theirParticipants: string[],
  mineParticipants: string[]
): boolean {
  const union = canonicalParticipants([
    ...mineParticipants,
    ...theirParticipants,
  ]);
  return electCoordinator(union) === from;
}

function validProposal(
  message: RoundMessage,
  from: string,
  params: FusionRendezvousParams
): message is Extract<RoundMessage, { type: 'round_proposal' }> {
  if (message.type !== 'round_proposal') return false;
  const participants = canonicalParticipants(message.participants);
  return (
    PUBKEY.test(from) &&
    message.session.match(SESSION) !== null &&
    message.network === params.network &&
    message.tier === params.tier &&
    // Epoch is informational on the rolling pool. Gather spans 30–90s and the
    // 30s epoch bucket often flips mid-gather; requiring equality rejected every
    // honest proposal when wallets started a few seconds apart.
    // ≥ MIN_PARTICIPANTS (3): onion mix needs ≥2 peelers; no 2-party proposals.
    participants.length >= MIN_PARTICIPANTS &&
    participants.length === message.participants.length &&
    sameParticipants(participants, message.participants) &&
    participants.includes(params.myPubkey) &&
    // Ask the election who may propose. This once read `participants[0] === from`,
    // which was the same answer only while the coordinator was the lowest pubkey.
    // Once election became set-bound the two disagreed, and a proposal from the
    // real coordinator was rejected as malformed by every participant — the round
    // then died as "round start timed out" and failover dropped the one peer that
    // was actually coordinating.
    electCoordinator(participants) === from
  );
}

/** Network + tier must match; epoch is ignored (rolling pool). */
function sameRoundBinding(
  message: { network: string; tier: number; epoch: number },
  params: Pick<FusionRendezvousParams, 'network' | 'tier'>
): boolean {
  return message.network === params.network && message.tier === params.tier;
}

function abortError(reason: string): Error {
  return new Error(`fusion round aborted: ${reason}`);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** How many silent coordinators we drop before giving up on the round. */
const MAX_COORDINATOR_FAILOVERS = 8;

/**
 * A pool announcement is a stored event a relay keeps replaying, so the elected
 * key can belong to a round nobody is running any more. Without failover every
 * live peer waits on that ghost until
 * the whole round times out ("round start timed out"). If the elected
 * coordinator never proposes, drop it and re-elect among the peers that are
 * left — one of which may now be us.
 */
export async function negotiateFusionRound(
  params: FusionRendezvousParams,
  transport: RoundTransport
): Promise<NegotiatedFusionRound> {
  if (!PUBKEY.test(params.myPubkey)) {
    throw new Error('invalid local Fusion round pubkey');
  }
  let candidates = canonicalParticipants([params.myPubkey, ...params.candidates]);
  const deadline =
    Date.now() + (params.timeoutMs ?? DEFAULT_RENDEZVOUS_TIMEOUT_MS);

  for (let attempt = 0; ; attempt += 1) {
    if (candidates.length < 3) {
      throw new Error(
        'P2P Fusion needs at least three fresh peers (CashFusion-style anonymity floor).'
      );
    }
    const coordinator = electCoordinator(candidates);
    if (!coordinator) {
      throw new Error('P2P Fusion coordinator election failed.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Round agreement timed out with ${candidates.length} candidate(s). ` +
          RENDEZVOUS_LATE_JOINER_HINT
      );
    }
    const iAmCoordinator = coordinator === params.myPubkey;
    // Participants get the whole remaining budget: the short proposal deadline
    // inside negotiateAsParticipant is what detects a ghost and triggers
    // failover, so there is no need to also slice the timeout here.
    const attemptParams = { ...params, candidates, timeoutMs: remaining };

    try {
      return iAmCoordinator
        ? await negotiateAsCoordinator(attemptParams, transport, candidates)
        : await negotiateAsParticipant(attemptParams, transport, coordinator);
    } catch (error) {
      const msg = String(error);
      const silentCoordinator =
        !iAmCoordinator && /round start timed out/.test(msg);
      if (!silentCoordinator || attempt >= MAX_COORDINATOR_FAILOVERS) {
        // Re-throw with late-joiner context when the bare timeout strings leak.
        if (
          /round (start|acknowledgments) timed out/i.test(msg) &&
          !msg.includes('smaller round')
        ) {
          throw new Error(
            `${msg.replace(/^Error:\s*/, '')}. ${RENDEZVOUS_LATE_JOINER_HINT}`
          );
        }
        throw error;
      }
      candidates = candidates.filter((pubkey) => pubkey !== coordinator);
      // Brief pause so peers that timed out the same ghost in the same tick can
      // all re-subscribe before the new coordinator's first proposal is sent.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

function negotiateAsCoordinator(
  params: FusionRendezvousParams,
  transport: RoundTransport,
  participants: string[]
): Promise<NegotiatedFusionRound> {
  const session = (params.sessionFactory ?? (() => binToHex(generateSecretKey())))();
  if (!SESSION.test(session)) {
    return Promise.reject(new Error('invalid Fusion session id'));
  }
  const others = participants.filter((pubkey) => pubkey !== params.myPubkey);
  const timeoutMs = params.timeoutMs ?? DEFAULT_RENDEZVOUS_TIMEOUT_MS;
  const settleMs =
    params.coordinatorSettleMs ??
    Math.min(5_000, Math.max(1_000, Math.floor(timeoutMs * 0.6)));
  // LIVE (2026-08-06): gather saw 4, then started with 2 ACKs → w1+w6 fused,
  // w4 alone shouting, w5 relay fail — not a valid pool.
  // Policy: the proposed set is the round. Full ACK or abort+retry together.
  // No "prefer pair / one missing" degradation — subsets leave peers behind.
  const makeProposal = (): RoundMessage => ({
    ...messageBinding(),
    type: 'round_proposal',
    session,
    network: params.network,
    tier: params.tier,
    epoch: params.epoch,
    participants,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let starting = false;
    let settlePassed = false;
    let yielded: Extract<RoundMessage, { type: 'round_proposal' }> | null = null;
    let yieldedCoordinator: string | null = null;
    let ownStartTimer: ReturnType<typeof setTimeout> | undefined;
    const acknowledgments = new Set<string>([params.myPubkey]);
    let unsubscribe: () => void = () => undefined;
    // Keep re-offering the proposal until the round starts. A peer still waiting
    // out a silent coordinator ignores proposals that do not outrank it, so it
    // would miss a one-shot offer sent before it failed over — and over Tor a
    // single dropped message would strand the round the same way.
    // Re-offer often: peers failing over a ghost may subscribe mid-interval and
    // would miss a 1.5s-spaced first proposal under a short proposalTimeout.
    const publishProposal = () =>
      Promise.allSettled(
        others.map((peer) => transport.send(peer, makeProposal()))
      );
    const reproposeTimer = setInterval(() => {
      if (settled || starting || yielded) return;
      void publishProposal();
    }, P2P_RENDEZVOUS_RESEND_MS);

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (ownStartTimer) clearTimeout(ownStartTimer);
      if (reproposeTimer) clearInterval(reproposeTimer);
      params.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
    };
    const finishError = async (error: Error, notify = true) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (notify) {
        const activeSession = yielded?.session ?? session;
        const targets = yieldedCoordinator ? [yieldedCoordinator] : others;
        const abort: RoundMessage = {
          ...messageBinding(),
          type: 'abort',
          session: activeSession,
          reason: error.message.slice(0, 240),
        };
        await Promise.allSettled(
          targets.map((peer) => transport.send(peer, abort))
        );
      }
      reject(error);
    };
    const finishSuccess = (value: NegotiatedFusionRound) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => {
      void finishError(abortError('cancelled'));
    };

    /** Always the full proposed set — never shrink (2-of-4 is a product failure). */
    const minAcksRequired = (): number => participants.length;

    const startOwnRound = () => {
      if (settled || yielded || starting) return;
      // Final set must equal the proposal exactly. ACKed-only subsets leave
      // lagging peers alone — refuse that path.
      const finalParticipants = [...acknowledgments].sort();
      const need = minAcksRequired();
      if (finalParticipants.length < need) {
        return;
      }
      if (!sameParticipants(finalParticipants, participants)) {
        return;
      }
      starting = true;
      const finalOthers = finalParticipants.filter((peer) => peer !== params.myPubkey);
      const start: RoundMessage = {
        ...messageBinding(),
        type: 'round_start',
        session,
        network: params.network,
        tier: params.tier,
        epoch: params.epoch,
        participants: finalParticipants,
      };
      void Promise.all(finalOthers.map((peer) => transport.send(peer, start)))
        .then(() =>
          finishSuccess({
            session,
            coordinator: params.myPubkey,
            participants: finalParticipants,
            network: params.network,
            tier: params.tier,
            epoch: params.epoch,
          })
        )
        .catch((error: unknown) => void finishError(asError(error)));
    };

    unsubscribe = transport.onMessage((from, message) => {
      if (settled) return;
      if (
        validProposal(message, from, params) &&
        from !== yieldedCoordinator &&
        // Beats the round we are running, and any round we already yielded to.
        outranks(from, message.participants, participants) &&
        (!yielded || outranks(from, message.participants, yielded.participants))
      ) {
        yielded = message;
        yieldedCoordinator = from;
        if (ownStartTimer) clearTimeout(ownStartTimer);
        ownStartTimer = undefined;
        const ack: RoundMessage = {
          ...messageBinding(),
          type: 'round_ack',
          session: message.session,
          network: params.network,
          tier: params.tier,
          epoch: params.epoch,
        };
        void transport
          .send(from, ack)
          .catch((error: unknown) => void finishError(asError(error), false));
        return;
      }
      if (
        message.type === 'abort' &&
        yieldedCoordinator === from &&
        yielded?.session === message.session
      ) {
        void finishError(abortError(message.reason), false);
        return;
      }
      if (
        message.type === 'round_start' &&
        yielded &&
        yieldedCoordinator === from &&
        message.session === yielded.session &&
        sameRoundBinding(message, params) &&
        message.participants.includes(params.myPubkey)
      ) {
        // Reject a start that dropped us into a subset of the gather we proposed.
        // (Remote coord must still start only its own full set under this policy.)
        finishSuccess({
          session: message.session,
          coordinator: from,
          participants: message.participants,
          network: params.network,
          tier: params.tier,
          epoch: params.epoch,
        });
        return;
      }
      if (
        yielded ||
        message.type !== 'round_ack' ||
        message.session !== session ||
        !sameRoundBinding(message, params) ||
        !others.includes(from)
      ) {
        return;
      }
      acknowledgments.add(from);
      // Start only after the settle window (so proposals have propagated and peers
      // have yielded — starting the instant the last ACK lands races the peers'
      // yield and can drop the round_start). Late ACKs after settle re-trigger.
      if (settlePassed) startOwnRound();
    });

    params.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      const acked = acknowledgments.size;
      const proposed = participants.length;
      // Never degrade to a partial set — abort so everyone retries cleanly.
      void finishError(
        new Error(
          `round acknowledgments timed out (only ${acked}/${proposed} answered). ` +
            `Refusing a partial round — full set must ACK. Auto will retry; ` +
            `keep Tor + Auto on.`
        )
      );
    }, timeoutMs);
    // After settle: start only when EVERY proposed peer has ACKed.
    ownStartTimer = setTimeout(() => {
      settlePassed = true;
      startOwnRound();
    }, settleMs);

    // Soft first publish: one relay blip must not kill the whole round.
    // Re-offer timer keeps trying; only fail if ALL attempts in this burst fail
    // AND we still have zero ACKs after a short grace (finishError from timer).
    void (async () => {
      for (let attempt = 0; attempt < 3 && !settled && !yielded; attempt++) {
        const results = await publishProposal();
        if (results.some((r) => r.status === 'fulfilled')) return;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
      // Keep waiting for peer-driven path / reproposeTimer; do not abort here.
    })();
  });
}

function negotiateAsParticipant(
  params: FusionRendezvousParams,
  transport: RoundTransport,
  expectedCoordinator: string
): Promise<NegotiatedFusionRound> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let accepted: Extract<RoundMessage, { type: 'round_proposal' }> | null =
      null;
    let acceptedCoordinator: string | null = null;
    let unsubscribe: () => void = () => undefined;
    let ackResendTimer: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (proposalTimer) clearTimeout(proposalTimer);
      if (ackResendTimer) clearInterval(ackResendTimer);
      params.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value: NegotiatedFusionRound) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => fail(abortError('cancelled'));

    const sendAck = (to: string, sessionId: string) => {
      const ack: RoundMessage = {
        ...messageBinding(),
        type: 'round_ack',
        session: sessionId,
        network: params.network,
        tier: params.tier,
        epoch: params.epoch,
      };
      // Never kill the round on one failed ACK publish — re-send handles Tor.
      return transport.send(to, ack).catch(() => undefined);
    };

    unsubscribe = transport.onMessage((from, message) => {
      if (settled) return;
      if (
        message.type === 'abort' &&
        from === (acceptedCoordinator ?? expectedCoordinator) &&
        (!accepted || message.session === accepted.session)
      ) {
        fail(abortError(message.reason));
        return;
      }
      if (validProposal(message, from, params)) {
        // Same ranking the coordinator side applies, from the other direction:
        // take a proposal only if it beats the round we are already waiting on.
        if (from === acceptedCoordinator) return;
        if (
          !acceptedCoordinator &&
          from !== expectedCoordinator &&
          !outranks(from, message.participants, params.candidates)
        ) {
          return;
        }
        if (
          accepted &&
          !outranks(from, message.participants, accepted.participants)
        ) {
          return;
        }
        accepted = message;
        acceptedCoordinator = from;
        void sendAck(from, message.session);
        // Re-ACK until round_start — coord may miss the first gift-wrap.
        if (ackResendTimer) clearInterval(ackResendTimer);
        ackResendTimer = setInterval(() => {
          if (settled || !accepted || !acceptedCoordinator) return;
          void sendAck(acceptedCoordinator, accepted.session);
        }, P2P_RENDEZVOUS_RESEND_MS);
        return;
      }
      if (
        message.type === 'round_start' &&
        accepted &&
        from === acceptedCoordinator &&
        message.session === accepted.session &&
        sameRoundBinding(message, params) &&
        message.participants.includes(params.myPubkey)
      ) {
        succeed({
          session: message.session,
          coordinator: from,
          participants: message.participants,
          network: params.network,
          tier: params.tier,
          epoch: params.epoch,
        });
      }
    });

    params.signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = params.timeoutMs ?? DEFAULT_RENDEZVOUS_TIMEOUT_MS;
    const timer = setTimeout(() => fail(new Error('round start timed out')), timeoutMs);
    // Ghost check: if the elected coordinator has not proposed at all by now it
    // is an abandoned round's stored announcement. Give up so the caller can
    // re-elect. Must stay long enough for Tor gift-wrap (see DEFAULT_PROPOSAL_TIMEOUT_MS).
    // Once a proposal HAS arrived we stay for the full timeout, because the
    // coordinator still has to finish its settle window before round_start.
    const proposalTimer = setTimeout(
      () => {
        if (!accepted) fail(new Error('round start timed out'));
      },
      Math.min(params.proposalTimeoutMs ?? DEFAULT_PROPOSAL_TIMEOUT_MS, timeoutMs)
    );
  });
}
