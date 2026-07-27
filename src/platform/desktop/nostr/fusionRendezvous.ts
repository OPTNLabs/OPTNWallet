import { generateSecretKey } from 'nostr-tools';

import { binToHex } from '../../../utils/hex';
import { electCoordinator, type FusionPoolNetwork } from './fusion';
import type { RoundMessage, RoundTransport } from './fusionSession';

const MAX_PARTICIPANTS = 20;
const DEFAULT_RENDEZVOUS_TIMEOUT_MS = 20_000;
const PUBKEY = /^[0-9a-f]{64}$/;
const SESSION = /^[0-9a-f]{64}$/;

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
    message.epoch === params.epoch &&
    participants.length >= 2 &&
    participants.length === message.participants.length &&
    sameParticipants(participants, message.participants) &&
    participants.includes(params.myPubkey) &&
    participants[0] === from
  );
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
 * Election picks the lowest pubkey, but a pool announcement is a stored event a
 * relay keeps replaying, so the "lowest" key can belong to a round nobody is
 * running any more. Without failover every live peer waits on that ghost until
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
    if (candidates.length < 2) {
      throw new Error('P2P Fusion needs at least two fresh peers.');
    }
    const coordinator = electCoordinator(candidates);
    if (!coordinator) {
      throw new Error('P2P Fusion coordinator election failed.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('round start timed out');
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
      const silentCoordinator =
        !iAmCoordinator && /round start timed out/.test(String(error));
      if (!silentCoordinator || attempt >= MAX_COORDINATOR_FAILOVERS) throw error;
      candidates = candidates.filter((pubkey) => pubkey !== coordinator);
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
  const proposal: RoundMessage = {
    type: 'round_proposal',
    session,
    network: params.network,
    tier: params.tier,
    epoch: params.epoch,
    participants,
  };

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
    // out a silent coordinator ignores proposals from higher keys, so it would
    // miss a one-shot offer sent before it failed over — and over Tor a single
    // dropped message would strand the round the same way.
    const reproposeTimer = setInterval(() => {
      if (settled || starting || yielded) return;
      void Promise.all(
        others.map((peer) => transport.send(peer, proposal))
      ).catch(() => undefined);
    }, 1_500);

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

    const startOwnRound = () => {
      if (settled || yielded || starting) return;
      // Final participant set = self + peers that actually ACKed (proven alive).
      // Stale/dead round keys (from earlier clicks/retries) never ACK and are
      // dropped here, so the round never waits on peers that aren't coming.
      const finalParticipants = [...acknowledgments].sort();
      if (finalParticipants.length < 2) {
        return; // not enough ACKs yet — keep waiting (or yield to a lower coordinator)
      }
      starting = true;
      const finalOthers = finalParticipants.filter((peer) => peer !== params.myPubkey);
      const start: RoundMessage = {
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
        from < params.myPubkey &&
        (!yieldedCoordinator || from < yieldedCoordinator)
      ) {
        yielded = message;
        yieldedCoordinator = from;
        if (ownStartTimer) clearTimeout(ownStartTimer);
        ownStartTimer = undefined;
        const ack: RoundMessage = {
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
        message.network === params.network &&
        message.tier === params.tier &&
        message.epoch === params.epoch &&
        message.participants.includes(params.myPubkey)
      ) {
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
        message.network !== params.network ||
        message.tier !== params.tier ||
        message.epoch !== params.epoch ||
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
    const timer = setTimeout(
      () => void finishError(new Error('round acknowledgments timed out')),
      timeoutMs
    );
    // After the settle window, start with whoever ACKed (don't require ALL peers).
    ownStartTimer = setTimeout(() => {
      settlePassed = true;
      startOwnRound();
    }, settleMs);

    void Promise.all(others.map((peer) => transport.send(peer, proposal))).catch(
      (error: unknown) =>
        void finishError(
          error instanceof Error ? error : new Error(String(error))
        )
    );
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

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (proposalTimer) clearTimeout(proposalTimer);
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
        if (from > expectedCoordinator && !acceptedCoordinator) return;
        if (acceptedCoordinator && from >= acceptedCoordinator) return;
        accepted = message;
        acceptedCoordinator = from;
        const ack: RoundMessage = {
          type: 'round_ack',
          session: message.session,
          network: params.network,
          tier: params.tier,
          epoch: params.epoch,
        };
        void transport.send(from, ack).catch((error: unknown) =>
          fail(error instanceof Error ? error : new Error(String(error)))
        );
        return;
      }
      if (
        message.type === 'round_start' &&
        accepted &&
        from === acceptedCoordinator &&
        message.session === accepted.session &&
        message.network === params.network &&
        message.tier === params.tier &&
        message.epoch === params.epoch &&
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
    // is an abandoned round's stored announcement. Give up on it quickly so the
    // caller can re-elect, instead of burning the whole budget on a dead key.
    // Once a proposal HAS arrived we stay for the full timeout, because the
    // coordinator still has to finish its settle window before round_start.
    const proposalTimer = setTimeout(
      () => {
        if (!accepted) fail(new Error('round start timed out'));
      },
      Math.min(params.proposalTimeoutMs ?? 3_500, timeoutMs)
    );
  });
}
