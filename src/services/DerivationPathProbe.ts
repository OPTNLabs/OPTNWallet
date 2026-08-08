// Supply the on-chain half of derivation-path discovery.
//
// DerivationPathDiscovery decides WHICH path to adopt. It deliberately knows
// nothing about deriving addresses or reaching a server, so it takes a `probe`
// callback. This module is that callback.
//
// The one rule that matters here: never report a zero we are not sure about.
// A path that looks empty because a server timed out is indistinguishable, to
// the user, from a path with no money — and acting on it sends their restored
// wallet to a fresh, wrong path while the coins sit untouched. So a probe that
// cannot answer THROWS. discoverDerivationPath records nothing for a throwing
// probe, which is what we want; the caller then sees fewer probed paths than
// candidates and can say "could not check" instead of "nothing found".

import type { RequestResponse } from '@electrum-cash/network';
import { Network } from '../state/slices/networkSlice';
import ElectrumServer from '../apis/ElectrumServer/ElectrumServer';
import {
  deriveBchAddressFromHdPublicKey,
  deriveBchStandardXpubs,
} from './HdWalletService';
import {
  addressToElectrumScripthash,
  isTransactionHistoryArray,
} from './electrum/helpers';
import {
  candidateAccountPaths,
  discoverDerivationPath,
  type DerivationPathDiscovery,
} from './DerivationPathDiscovery';

/** Consecutive unused addresses before a branch is considered exhausted. */
export const PROBE_GAP_LIMIT = 20;

/**
 * Hard ceiling per branch. The gap limit normally stops the scan long before
 * this; the cap exists so a wallet with thousands of used addresses cannot turn
 * a discovery probe into an unbounded server hammering.
 */
export const PROBE_MAX_ADDRESSES = 200;

export type BranchXpubs = { receive: string; change: string };

/** Resolve the receive and change xpubs for one candidate account path. */
export type AccountXpubResolver = (accountPath: string) => Promise<BranchXpubs>;

export interface DerivationScanResult extends DerivationPathDiscovery {
  /** Candidate paths that returned an answer. */
  candidatesProbed: number;
  /** Candidate paths offered for this network. */
  candidatesTotal: number;
  /**
   * True when at least one candidate could not be checked.
   *
   * `chosen === null && incomplete` means "we do not know", NOT "there is
   * nothing". Callers must not present those the same way.
   */
  incomplete: boolean;
}

export class ProbeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeUnavailableError';
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Derivation scan aborted', 'AbortError');
  }
}

type ProbeBatchCall = { method: string; params: RequestResponse[] };

async function requestFreshBatch(
  calls: ProbeBatchCall[],
  signal?: AbortSignal
): Promise<Array<RequestResponse | Error>> {
  assertNotAborted(signal);
  let responses: Array<RequestResponse | Error>;
  try {
    // Wallet-facing ElectrumService caches may return a stale [] after a
    // failed refresh. That keeps an open wallet stable, but is unsafe while
    // deciding which derivation path owns funds, so discovery goes direct.
    responses = await ElectrumServer().requestMany(calls);
  } catch (error) {
    throw new ProbeUnavailableError(
      error instanceof Error
        ? `Electrum request failed: ${error.message}`
        : 'Electrum request failed.'
    );
  }
  assertNotAborted(signal);
  if (responses.length !== calls.length) {
    throw new ProbeUnavailableError('Electrum returned an incomplete batch.');
  }
  return responses;
}

/**
 * Walk one branch until `gapLimit` consecutive addresses show no history.
 * Requests are batched in gap-sized windows, reducing an empty chipnet scan
 * from 240 serial round trips to 12 batches (receive + change per candidate).
 *
 * Live UTXOs are read only for addresses that actually have history. Both
 * lookups bypass wallet caches and treat every partial/invalid response as
 * unavailable, so a stale cached empty result can never become a path choice.
 */
async function scanBranch(
  network: Network,
  hdPublicKey: string,
  signal?: AbortSignal
): Promise<{ usedAddresses: number; satoshis: bigint }> {
  let usedAddresses = 0;
  let satoshis = 0n;
  let gap = 0;
  let index = 0;

  while (index < PROBE_MAX_ADDRESSES && gap < PROBE_GAP_LIMIT) {
    assertNotAborted(signal);

    // Ask for exactly enough addresses to exhaust the remaining gap. If one
    // is used, the next iteration extends from that point; no request is made
    // for addresses beyond the first valid gap-limit boundary.
    const batchSize = Math.min(
      PROBE_GAP_LIMIT - gap,
      PROBE_MAX_ADDRESSES - index
    );
    const addresses: Array<{ address: string; scriptHash: string }> = [];
    for (let offset = 0; offset < batchSize; offset++) {
      const derived = deriveBchAddressFromHdPublicKey(
        network,
        hdPublicKey,
        BigInt(index + offset)
      );
      if (!derived) {
        throw new ProbeUnavailableError(
          `Could not derive address ${index + offset} for this path.`
        );
      }
      addresses.push({
        address: derived.address,
        scriptHash: addressToElectrumScripthash(derived.address),
      });
    }
    index += batchSize;

    const histories = await requestFreshBatch(
      addresses.map(({ scriptHash }) => ({
        method: 'blockchain.scripthash.get_history',
        params: [scriptHash],
      })),
      signal
    );

    const usedInBatch: Array<{ address: string; scriptHash: string }> = [];
    histories.forEach((history, offset) => {
      if (history instanceof Error || !isTransactionHistoryArray(history)) {
        throw new ProbeUnavailableError(
          'Address history is unavailable right now.'
        );
      }
      if (history.length === 0) {
        gap += 1;
      } else {
        usedAddresses += 1;
        gap = 0;
        usedInBatch.push(addresses[offset]);
      }
    });

    if (usedInBatch.length === 0) continue;

    const unspentResponses = await requestFreshBatch(
      usedInBatch.map(({ scriptHash }) => ({
        method: 'blockchain.scripthash.listunspent',
        params: [scriptHash],
      })),
      signal
    );
    unspentResponses.forEach((response) => {
      if (response instanceof Error || !Array.isArray(response)) {
        throw new ProbeUnavailableError(
          'Live balance is unavailable right now.'
        );
      }
      for (const rawUtxo of response) {
        if (!rawUtxo || typeof rawUtxo !== 'object') {
          throw new ProbeUnavailableError(
            'The server returned an invalid UTXO row.'
          );
        }
        const value = (rawUtxo as { value?: unknown }).value;
        if (!Number.isSafeInteger(value) || (value as number) < 0) {
          throw new ProbeUnavailableError(
            'The server returned an invalid UTXO value.'
          );
        }
        satoshis += BigInt(value as number);
      }
    });
  }

  if (index >= PROBE_MAX_ADDRESSES && gap < PROBE_GAP_LIMIT) {
    throw new ProbeUnavailableError(
      `Address scan reached its ${PROBE_MAX_ADDRESSES}-address safety limit before finding an unused gap.`
    );
  }

  return { usedAddresses, satoshis };
}

/**
 * Probe every candidate path for `network` and report which one holds coins.
 *
 * Read-only: derives public addresses and reads history. Moves no funds,
 * persists nothing, and adopts nothing — the caller decides what to do with the
 * result.
 */
export async function scanDerivationPaths(
  network: Network,
  resolveXpubs: AccountXpubResolver,
  options: {
    signal?: AbortSignal;
    onProgress?: (completed: number, total: number) => void;
  } = {}
): Promise<DerivationScanResult> {
  const { signal, onProgress } = options;
  const candidatesTotal = candidateAccountPaths(network).length;
  let completed = 0;

  const discovery = await discoverDerivationPath(
    network,
    async (accountPath) => {
      assertNotAborted(signal);
      try {
        const { receive, change } = await resolveXpubs(accountPath);
        const [receiveResult, changeResult] = await Promise.all([
          scanBranch(network, receive, signal),
          scanBranch(network, change, signal),
        ]);
        return {
          usedAddresses:
            receiveResult.usedAddresses + changeResult.usedAddresses,
          satoshis: receiveResult.satoshis + changeResult.satoshis,
        };
      } finally {
        // Counted in `finally` so the progress bar advances even for a candidate
        // that failed — otherwise a dead server looks like a stalled scan.
        completed += 1;
        onProgress?.(completed, candidatesTotal);
      }
    }
  );

  // discoverDerivationPath swallows every probe error on purpose — one dead
  // server must not decide a path is empty. That also swallows our AbortError,
  // so a cancelled scan would otherwise return `chosen: null, incomplete: true`
  // and read exactly like "no server answered". Re-check here so cancelling
  // rejects instead of reporting a result nobody asked for. The remaining
  // candidates still get visited, but each throws on its first check, so this
  // costs a handful of no-ops rather than a full scan.
  assertNotAborted(signal);

  return {
    ...discovery,
    candidatesProbed: discovery.probed.length,
    candidatesTotal,
    incomplete: discovery.probed.length < candidatesTotal,
  };
}

/**
 * Resolver for a seed the caller already holds — the import flow, where the
 * user just typed their recovery phrase and no wallet exists yet.
 *
 * The mnemonic stays in the caller's scope and is never logged or persisted by
 * this module. For an existing wallet use KeyManager.getXpubsForAccountPath
 * instead, which keeps the seed inside the key layer entirely.
 */
export function mnemonicXpubResolver(
  network: Network,
  mnemonic: string,
  passphrase: string
): AccountXpubResolver {
  return async (accountPath: string) => {
    const xpubs = await deriveBchStandardXpubs(
      network,
      mnemonic,
      passphrase,
      // accountPath already encodes the account index (candidateAccountPaths
      // emits m/44'/coin'/0' and m/44'/coin'/1'), so this argument is unused.
      0,
      accountPath
    );
    return { receive: xpubs.receive, change: xpubs.change };
  };
}
