// A restored wallet that reports zero because it looked at the wrong path is
// indistinguishable from a wallet with no money. These tests pin the behaviour
// that stops that: probe the paths BCH tooling actually uses, and never decide
// "empty" from a failed lookup.

import { describe, expect, it, vi } from 'vitest';
import { Network } from '../../state/slices/networkSlice';
import {
  candidateAccountPaths,
  discoverDerivationPath,
} from '../DerivationPathDiscovery';

const empty = { usedAddresses: 0, satoshis: 0n };

describe('derivation path discovery', () => {
  it('tries the chipnet default and legacy BCH types during discovery', () => {
    const paths = candidateAccountPaths(Network.CHIPNET);
    expect(paths[0]).toBe("m/44'/1'/0'");
    expect(paths).toContain("m/44'/145'/0'");
    expect(paths).toContain("m/44'/1'/0'");
    expect(paths).toContain("m/44'/0'/0'");
  });

  it('does not offer the testnet coin type on mainnet', () => {
    expect(candidateAccountPaths(Network.MAINNET)).not.toContain("m/44'/1'/0'");
  });

  it('adopts the funded path even when it is not the default', async () => {
    const result = await discoverDerivationPath(Network.CHIPNET, async (path) =>
      path === "m/44'/1'/0'" ? { usedAddresses: 3, satoshis: 20_000n } : empty
    );
    expect(result.chosen).toBe("m/44'/1'/0'");
    expect(result.ambiguous).toBe(false);
  });

  it('flags ambiguity instead of silently picking when two paths hold coins', async () => {
    // Choosing one quietly would hide the other path's money from the user.
    const result = await discoverDerivationPath(Network.CHIPNET, async (path) =>
      path === "m/44'/145'/0'"
        ? { usedAddresses: 2, satoshis: 50_000n }
        : path === "m/44'/1'/0'"
          ? { usedAddresses: 1, satoshis: 10_000n }
          : empty
    );
    expect(result.chosen).toBe("m/44'/145'/0'"); // larger balance leads
    expect(result.ambiguous).toBe(true);
  });

  it('adopts a spent-down path so new addresses continue the same chain', async () => {
    const result = await discoverDerivationPath(Network.MAINNET, async (path) =>
      path === "m/44'/0'/0'" ? { usedAddresses: 7, satoshis: 0n } : empty
    );
    expect(result.chosen).toBe("m/44'/0'/0'");
  });

  it('reports nothing found rather than guessing when every path is empty', async () => {
    const result = await discoverDerivationPath(Network.MAINNET, async () => empty);
    expect(result.chosen).toBeNull();
    expect(result.ambiguous).toBe(false);
  });

  it('never treats a lookup failure as an empty path', async () => {
    // One unreachable server deciding "no coins here" is exactly how a wallet
    // concludes it is empty and moves on.
    const probe = vi.fn(async (path: string) => {
      if (path === "m/44'/145'/0'") throw new Error('server unreachable');
      return path === "m/44'/1'/0'" ? { usedAddresses: 1, satoshis: 5_000n } : empty;
    });
    const result = await discoverDerivationPath(Network.CHIPNET, probe);

    expect(result.chosen).toBe("m/44'/1'/0'");
    // The failed path is absent, not recorded as a zero.
    expect(result.probed.some((r) => r.path === "m/44'/145'/0'")).toBe(false);
  });
});
