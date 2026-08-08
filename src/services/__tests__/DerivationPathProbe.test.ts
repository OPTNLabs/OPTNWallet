import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Network } from '../../state/slices/networkSlice';

const { requestManyMock, deriveAddressMock } = vi.hoisted(() => ({
  requestManyMock: vi.fn(),
  deriveAddressMock: vi.fn(),
}));

vi.mock('../../apis/ElectrumServer/ElectrumServer', () => ({
  default: () => ({ requestMany: requestManyMock }),
}));

vi.mock('../electrum/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../electrum/helpers')>();
  return {
    ...actual,
    addressToElectrumScripthash: (address: string) => address,
  };
});

vi.mock('../HdWalletService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../HdWalletService')>();
  return {
    ...actual,
    deriveBchAddressFromHdPublicKey: deriveAddressMock,
  };
});

import {
  PROBE_GAP_LIMIT,
  PROBE_MAX_ADDRESSES,
  ProbeUnavailableError,
  scanDerivationPaths,
} from '../DerivationPathProbe';
import { candidateAccountPaths } from '../DerivationPathDiscovery';

/** Addresses are `${accountPath}|${branch}|${index}` so tests can target them. */
const resolver = async (accountPath: string) => ({
  receive: `${accountPath}|receive`,
  change: `${accountPath}|change`,
});

type BatchCall = { method: string; params?: unknown[] };

function answerBatch(
  calls: BatchCall[],
  answer: (method: string, address: string) => unknown
): unknown[] {
  return calls.map((call) =>
    answer(call.method, String(call.params?.[0] ?? ''))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  deriveAddressMock.mockImplementation(
    (_network: Network, hdPublicKey: string, index: bigint) => ({
      address: `${hdPublicKey}|${index.toString()}`,
      tokenAddress: `${hdPublicKey}|token|${index.toString()}`,
      publicKey: new Uint8Array(33),
      publicKeyHash: new Uint8Array(20),
    })
  );
  requestManyMock.mockImplementation(async (calls: BatchCall[]) =>
    answerBatch(calls, () => [])
  );
});

describe('scanDerivationPaths', () => {
  it('adopts the path that actually holds coins', async () => {
    const funded = "m/44'/1'/0'";
    requestManyMock.mockImplementation(async (calls: BatchCall[]) =>
      answerBatch(calls, (method, address) => {
        if (method.endsWith('get_history')) {
          return address === `${funded}|receive|0`
            ? [{ tx_hash: 'a', height: 1 }]
            : [];
        }
        return address === `${funded}|receive|0` ? [{ value: 25_000 }] : [];
      })
    );

    const result = await scanDerivationPaths(Network.CHIPNET, resolver);

    expect(result.chosen).toBe(funded);
    expect(result.ambiguous).toBe(false);
    expect(result.incomplete).toBe(false);
    expect(result.candidatesProbed).toBe(result.candidatesTotal);
  });

  it('reports ambiguity instead of silently picking when two paths hold coins', async () => {
    requestManyMock.mockImplementation(async (calls: BatchCall[]) =>
      answerBatch(calls, (method, address) => {
        const fundedAddress =
          address.endsWith('|receive|0') &&
          (address.startsWith("m/44'/1'/0'") ||
            address.startsWith("m/44'/145'/0'"));
        if (method.endsWith('get_history')) {
          return fundedAddress ? [{ tx_hash: 'a', height: 1 }] : [];
        }
        return address.startsWith("m/44'/145'/0'") && fundedAddress
          ? [{ value: 50_000 }]
          : address.startsWith("m/44'/1'/0'") && fundedAddress
            ? [{ value: 10_000 }]
            : [];
      })
    );

    const result = await scanDerivationPaths(Network.CHIPNET, resolver);

    expect(result.ambiguous).toBe(true);
    // Highest balance still wins, but the caller is told there is another.
    expect(result.chosen).toBe("m/44'/145'/0'");
  });

  // The reason this module exists. An unreachable server must never look like
  // an empty path, because the two lead to opposite actions.
  it('does not turn an unreachable server into an empty path', async () => {
    requestManyMock.mockImplementation(async (calls: BatchCall[]) =>
      answerBatch(calls, () => new Error('server unavailable'))
    );

    const result = await scanDerivationPaths(Network.CHIPNET, resolver);

    expect(result.chosen).toBeNull();
    expect(result.candidatesProbed).toBe(0);
    expect(result.incomplete).toBe(true);
  });

  it('separates "nothing found" from "could not check"', async () => {
    const result = await scanDerivationPaths(Network.CHIPNET, resolver);

    expect(result.chosen).toBeNull();
    // Same chosen value as the unreachable case above — only `incomplete`
    // tells them apart, so it has to be right.
    expect(result.incomplete).toBe(false);
    expect(result.candidatesProbed).toBe(
      candidateAccountPaths(Network.CHIPNET).length
    );
  });

  it('keeps a path whose coins were spent down', async () => {
    const used = "m/44'/1'/0'";
    requestManyMock.mockImplementation(async (calls: BatchCall[]) =>
      answerBatch(calls, (method, address) =>
        method.endsWith('get_history') && address === `${used}|receive|0`
          ? [{ tx_hash: 'a', height: 1 }]
          : []
      )
    );
    const result = await scanDerivationPaths(Network.CHIPNET, resolver);

    // No balance anywhere, but history means new addresses must continue here
    // rather than starting a parallel set.
    expect(result.chosen).toBe(used);
  });

  it('does not treat an unavailable live-balance lookup as zero', async () => {
    const used = "m/44'/1'/0'";
    requestManyMock.mockImplementation(async (calls: BatchCall[]) =>
      answerBatch(calls, (method, address) => {
        if (method.endsWith('get_history')) {
          return address === `${used}|receive|0`
            ? [{ tx_hash: 'a', height: 1 }]
            : [];
        }
        return new Error('server unavailable');
      })
    );

    const result = await scanDerivationPaths(Network.CHIPNET, resolver);

    expect(result.chosen).toBeNull();
    expect(result.incomplete).toBe(true);
    expect(result.candidatesProbed).toBe(result.candidatesTotal - 1);
  });

  it('stops a branch after the gap limit instead of scanning forever', async () => {
    await scanDerivationPaths(Network.CHIPNET, resolver);

    const candidates = candidateAccountPaths(Network.CHIPNET).length;
    const historyBatches = requestManyMock.mock.calls
      .map(([calls]) => calls as BatchCall[])
      .filter((calls) => calls[0]?.method.endsWith('get_history'));
    // One 20-address history batch per branch, rather than 240 serial RPCs.
    expect(historyBatches).toHaveLength(candidates * 2);
    expect(historyBatches.flat()).toHaveLength(
      candidates * 2 * PROBE_GAP_LIMIT
    );
  });

  it('marks a candidate incomplete when the safety cap is hit before a gap', async () => {
    const capped = "m/44'/1'/0'";
    requestManyMock.mockImplementation(async (calls: BatchCall[]) =>
      answerBatch(calls, (method, address) => {
        if (
          method.endsWith('get_history') &&
          address.startsWith(`${capped}|receive|`)
        ) {
          return [{ tx_hash: 'a', height: 1 }];
        }
        return [];
      })
    );

    const result = await scanDerivationPaths(Network.CHIPNET, resolver);

    expect(result.chosen).toBeNull();
    expect(result.incomplete).toBe(true);
    expect(result.candidatesProbed).toBe(result.candidatesTotal - 1);
    const cappedHistoryCalls = requestManyMock.mock.calls
      .flatMap(([calls]) => calls as BatchCall[])
      .filter(
        (call) =>
          call.method.endsWith('get_history') &&
          String(call.params?.[0] ?? '').startsWith(`${capped}|receive|`)
      );
    expect(cappedHistoryCalls).toHaveLength(PROBE_MAX_ADDRESSES);
  });

  it('bypasses cached wallet lookups and rejects a partial batch failure', async () => {
    requestManyMock.mockImplementation(async (calls: BatchCall[]) =>
      answerBatch(calls, (_method, address) =>
        address.endsWith('|receive|3')
          ? new Error('partial transport failure')
          : []
      )
    );

    const result = await scanDerivationPaths(Network.CHIPNET, resolver);

    expect(result.incomplete).toBe(true);
    expect(result.candidatesProbed).toBe(0);
    expect(
      requestManyMock.mock.calls
        .flatMap(([calls]) => calls as BatchCall[])
        .every((call) => call.method.startsWith('blockchain.scripthash.'))
    ).toBe(true);
  });

  it('reports progress for a candidate that failed, not just successful ones', async () => {
    requestManyMock.mockImplementation(async (calls: BatchCall[]) =>
      answerBatch(calls, () => new Error('server unavailable'))
    );
    const seen: Array<[number, number]> = [];

    await scanDerivationPaths(Network.CHIPNET, resolver, {
      onProgress: (completed, total) => seen.push([completed, total]),
    });

    const candidates = candidateAccountPaths(Network.CHIPNET).length;
    expect(seen).toHaveLength(candidates);
    expect(seen[seen.length - 1]).toEqual([candidates, candidates]);
  });

  it('surfaces a resolver failure as an unchecked candidate, not an empty one', async () => {
    const failing = async (accountPath: string) => {
      if (accountPath === "m/44'/1'/0'") {
        throw new ProbeUnavailableError('xpub unavailable');
      }
      return resolver(accountPath);
    };

    const result = await scanDerivationPaths(Network.CHIPNET, failing);

    expect(result.incomplete).toBe(true);
    expect(result.candidatesProbed).toBe(result.candidatesTotal - 1);
  });

  it('aborts promptly when the caller cancels', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      scanDerivationPaths(Network.CHIPNET, resolver, {
        signal: controller.signal,
      })
    ).rejects.toThrow(/abort/i);
    expect(requestManyMock).not.toHaveBeenCalled();
  });
});
