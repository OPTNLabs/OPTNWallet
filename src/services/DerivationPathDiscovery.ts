// Find the derivation path a seed's coins are actually on.
//
// A restored wallet that derives one path and reports zero is indistinguishable
// from a wallet with no money — the scan completes, the balance is honest for
// the addresses it looked at, and the coins sit untouched on a path nobody
// checked. Asking the user which path they used is not an answer: the whole
// reason they are restoring is that the other tool made that choice for them.
//
// So the wallet probes the paths BCH tooling actually uses and adopts whichever
// one has history. Electron Cash does the same thing when it opens a seed it
// did not create.
//
// This is a read-only lookup against address history. It moves no funds and
// changes nothing until a caller decides to adopt the result.

import { Network } from '../state/slices/networkSlice';

/**
 * Candidate account paths, most likely first.
 *
 * Chipnet defaults to 1, while 145 remains common in BCH tooling and older
 * wallet builds. 0 appears when a seed was created in a Bitcoin wallet and
 * later used for BCH.
 */
export function candidateAccountPaths(network: Network): string[] {
  const accounts = [0, 1];
  const coinTypes = network === Network.MAINNET ? [145, 0] : [1, 145, 0];
  const paths: string[] = [];
  for (const coinType of coinTypes) {
    for (const account of accounts) {
      paths.push(`m/44'/${coinType}'/${account}'`);
    }
  }
  return paths;
}

export interface PathProbeResult {
  path: string;
  /** Addresses on this path that have ever been used. */
  usedAddresses: number;
  /** Confirmed + unconfirmed satoshis currently held. */
  satoshis: bigint;
}

export interface DerivationPathDiscovery {
  /** The path to adopt, or null when nothing was found anywhere. */
  chosen: string | null;
  /** Every path probed, so a caller can explain the choice. */
  probed: PathProbeResult[];
  /**
   * True when more than one path holds coins.
   *
   * The wallet must NOT silently pick one: that hides money. The user has to be
   * told, because merging paths is a decision with consequences they own.
   */
  ambiguous: boolean;
}

/**
 * Probe each candidate path and report which one holds the coins.
 *
 * `probe` is injected so this is testable without a network, and so the caller
 * decides how addresses are derived and how history is fetched.
 */
export async function discoverDerivationPath(
  network: Network,
  probe: (accountPath: string) => Promise<{ usedAddresses: number; satoshis: bigint }>
): Promise<DerivationPathDiscovery> {
  const probed: PathProbeResult[] = [];

  for (const path of candidateAccountPaths(network)) {
    try {
      const result = await probe(path);
      probed.push({ path, ...result });
    } catch {
      // One unreachable server must not decide that a path is empty — that is
      // exactly how a wallet concludes "no coins" and moves on. Record nothing
      // for this path rather than a false zero.
    }
  }

  const funded = probed.filter((r) => r.satoshis > 0n);
  if (funded.length > 0) {
    // Highest balance wins when several are funded, but the ambiguity is
    // reported so the caller can surface it rather than quietly choosing.
    const best = funded.reduce((a, b) => (b.satoshis > a.satoshis ? b : a));
    return { chosen: best.path, probed, ambiguous: funded.length > 1 };
  }

  // No balance anywhere, but a path with history is still the right one to
  // adopt: the wallet has been used and spent down, and new addresses must
  // continue from there rather than starting a parallel set.
  const used = probed.filter((r) => r.usedAddresses > 0);
  if (used.length > 0) {
    const best = used.reduce((a, b) => (b.usedAddresses > a.usedAddresses ? b : a));
    return { chosen: best.path, probed, ambiguous: used.length > 1 };
  }

  return { chosen: null, probed, ambiguous: false };
}
