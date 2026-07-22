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

export function negotiateFusionRound(
  params: FusionRendezvousParams,
  transport: RoundTransport
): Promise<NegotiatedFusionRound> {
  if (!PUBKEY.test(params.myPubkey)) {
    return Promise.reject(new Error('invalid local Fusion round pubkey'));
  }
  const candidates = canonicalParticipants([
    params.myPubkey,
    ...params.candidates,
  ]);
  if (candidates.length < 2) {
    return Promise.reject(new Error('P2P Fusion needs at least two fresh peers.'));
  }
  const coordinator = electCoordinator(candidates);
  if (!coordinator) {
    return Promise.reject(new Error('P2P Fusion coordinator election failed.'));
  }
  return coordinator === params.myPubkey
    ? negotiateAsCoordinator(params, transport, candidates)
    : negotiateAsParticipant(params, transport, coordinator);
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
  const coordinatorDecisionAt = Date.now() + settleMs;

  return new Promise((resolve, reject) => {
    let settled = false;
    let starting = false;
    let yielded: Extract<RoundMessage, { type: 'round_proposal' }> | null = null;
    let yieldedCoordinator: string | null = null;
    let ownStartTimer: ReturnType<typeof setTimeout> | undefined;
    const acknowledgments = new Set<string>([params.myPubkey]);
    let unsubscribe: () => void = () => undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (ownStartTimer) clearTimeout(ownStartTimer);
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
      starting = true;
      ownStartTimer = setTimeout(() => {
        if (settled || yielded) return;
        const start: RoundMessage = {
          type: 'round_start',
          session,
          network: params.network,
          tier: params.tier,
          epoch: params.epoch,
          participants,
        };
        void Promise.all(others.map((peer) => transport.send(peer, start)))
          .then(() =>
            finishSuccess({
              session,
              coordinator: params.myPubkey,
              participants,
              network: params.network,
              tier: params.tier,
              epoch: params.epoch,
            })
          )
          .catch((error: unknown) => void finishError(asError(error)));
      }, Math.max(0, coordinatorDecisionAt - Date.now()));
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
        sameParticipants(message.participants, yielded.participants)
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
      if (acknowledgments.size === participants.length) startOwnRound();
    });

    params.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => void finishError(new Error('round acknowledgments timed out')),
      timeoutMs
    );

    const proposal: RoundMessage = {
      type: 'round_proposal',
      session,
      network: params.network,
      tier: params.tier,
      epoch: params.epoch,
      participants,
    };
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
        sameParticipants(message.participants, accepted.participants)
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
    const timer = setTimeout(
      () => fail(new Error('round start timed out')),
      params.timeoutMs ?? DEFAULT_RENDEZVOUS_TIMEOUT_MS
    );
  });
}
