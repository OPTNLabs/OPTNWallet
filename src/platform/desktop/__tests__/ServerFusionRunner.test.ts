import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock FusionService (gatherInputs, createFreshFusionOutputScripts) ---
const mockGatherInputs = vi.fn();
const mockCreateFreshScripts = vi.fn();
vi.mock('../FusionService', () => ({
  gatherInputs: (...a: unknown[]) => mockGatherInputs(...a),
  createFreshFusionOutputScripts: (...a: unknown[]) =>
    mockCreateFreshScripts(...a),
}));

const mockFetchFusionStatus = vi.fn();
vi.mock('../../../services/fusion/FusionStatusService', () => ({
  fetchFusionServerStatus: (...a: unknown[]) => mockFetchFusionStatus(...a),
}));

// --- Mock Tauri invoke ---
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => mockInvoke(...a),
}));

// --- Mock FusionCompletionService ---
const mockCompleteFusionBroadcast = vi.fn();
vi.mock('../FusionCompletionService', () => ({
  completeFusionBroadcast: (...a: unknown[]) =>
    mockCompleteFusionBroadcast(...a),
  fusionCompletionWarning: (c: { tracked: boolean; refreshed: boolean }) =>
    !c.tracked ? 'tracking failed' : undefined,
}));

const mockTrackAttempt = vi.fn();
vi.mock('../../../services/OutboundTransactionTracker', () => ({
  default: {
    trackAttempt: (...a: unknown[]) => mockTrackAttempt(...a),
  },
}));

const mockReservedOutpoints = vi.fn();
const mockReserveOutpoints = vi.fn();
const mockReleaseOutpoints = vi.fn();
vi.mock('../fusionRoundState', () => ({
  outpointKey: (txid: string, index: number) => `${txid}:${index}`,
  reservedOutpoints: (...a: unknown[]) => mockReservedOutpoints(...a),
  reserveOutpoints: (...a: unknown[]) => mockReserveOutpoints(...a),
  releaseOutpoints: (...a: unknown[]) => mockReleaseOutpoints(...a),
}));

import {
  validateServerHello,
  randomOutputsForTier,
  allocateAllFeasibleTiers,
  buildServerRunner,
  parseElectrumLookupEndpoint,
  parseFusionServerTarget,
  type ServerHelloSnapshot,
} from '../ServerFusionRunner';
import { Network } from '../../../state/slices/networkSlice';

// --- EC-compatible constants ---
const MAX_COMPONENT_FEERATE = 5000;
const MAX_EXCESS_FEE = 10_000;
const MAX_COMPONENTS = 40;

describe('server endpoint parsing', () => {
  it('parses CashFusion TLS/plain targets and rejects ambiguous input', () => {
    expect(parseFusionServerTarget('fusion.example:8789')).toEqual({
      host: 'fusion.example',
      port: 8789,
      useSsl: true,
    });
    expect(parseFusionServerTarget('localhost:8788:t')).toEqual({
      host: 'localhost',
      port: 8788,
      useSsl: false,
    });
    expect(() => parseFusionServerTarget('')).toThrow('invalid');
    expect(() => parseFusionServerTarget('host:70000')).toThrow('invalid');
  });

  it('maps WSS Electrum endpoints onto native TCP ports', () => {
    expect(
      parseElectrumLookupEndpoint('wss://electrum.example:50004')
    ).toEqual({
      host: 'electrum.example',
      port: 50002,
      useSsl: true,
    });
    expect(parseElectrumLookupEndpoint('electrum.example')).toEqual({
      host: 'electrum.example',
      port: 50002,
      useSsl: true,
    });
  });
});

const installNativeMocks = (fusionOutcome?: unknown) => {
  const txid =
    typeof fusionOutcome === 'object' &&
    fusionOutcome !== null &&
    'txid' in fusionOutcome &&
    typeof fusionOutcome.txid === 'string'
      ? fusionOutcome.txid
      : null;
  mockTrackAttempt.mockResolvedValue(txid ? { txid } : null);
  mockInvoke.mockImplementation((command: string) => {
    if (command === 'fusion_execution_status') {
      return Promise.resolve({ ready: true, message: null });
    }
    if (
      command === 'fusion_prepare_round' ||
      command === 'fusion_cancel_round'
    ) {
      return Promise.resolve(command === 'fusion_cancel_round');
    }
    if (command === 'fusion_run') {
      return Promise.resolve(fusionOutcome);
    }
    if (command === 'fusion_relay_broadcast_and_observe' && txid) {
      return Promise.resolve({
        txid,
        relaySubmitted: true,
        observerSeen: true,
      });
    }
    return Promise.reject(new Error(`unexpected command ${command}`));
  });
};

function makeHello(overrides: Partial<ServerHelloSnapshot> = {}): ServerHelloSnapshot {
  return {
    tiers: [10_000, 100_000],
    numComponents: 23,
    componentFeerate: 1000,
    minExcessFee: 10,
    maxExcessFee: 10_000,
    ...overrides,
  };
}

describe('validateServerHello — EC limits', () => {
  it('accepts a valid ServerHello', () => {
    expect(() => validateServerHello(makeHello())).not.toThrow();
  });

  it('rejects excessive component feerate (> MAX_COMPONENT_FEERATE=5000)', () => {
    expect(() =>
      validateServerHello(makeHello({ componentFeerate: MAX_COMPONENT_FEERATE + 1 }))
    ).toThrow('excessive component feerate');
  });

  it('rejects min_excess_fee > 400', () => {
    expect(() =>
      validateServerHello(makeHello({ minExcessFee: 401 }))
    ).toThrow('excessive min excess fee');
  });

  it('rejects min_excess_fee > max_excess_fee', () => {
    expect(() =>
      validateServerHello(makeHello({ minExcessFee: 100, maxExcessFee: 50 }))
    ).toThrow('bad config on server: fees');
  });

  it('rejects num_components < 1.5 * MIN_TX_COMPONENTS', () => {
    // 1.5 * 11 = 16.5, so 16 should fail
    expect(() =>
      validateServerHello(makeHello({ numComponents: 16 }))
    ).toThrow('bad config on server: num_components');
  });

  it('accepts num_components >= 17 (ceil of 1.5 * 11)', () => {
    expect(() =>
      validateServerHello(makeHello({ numComponents: 17 }))
    ).not.toThrow();
  });

  it('rejects duplicate tiers and component counts above the wallet cap', () => {
    expect(() =>
      validateServerHello(makeHello({ tiers: [10_000, 10_000] }))
    ).toThrow('tiers');
    expect(() =>
      validateServerHello(makeHello({ numComponents: MAX_COMPONENTS + 1 }))
    ).toThrow('num_components');
  });
});

describe('randomOutputsForTier — EC-compatible exponential distribution', () => {
  // Deterministic pseudo-random for tests
  const seedRng = () => {
    let x = 42;
    return () => {
      // xorshift32
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 0x100000000;
    };
  };

  it('returns null when input_amount < offset', () => {
    expect(randomOutputsForTier(seedRng(), 99, 1000, 100, 5)).toBeNull();
  });

  it('output values sum exactly to input_amount', () => {
    const result = randomOutputsForTier(seedRng(), 500_000, 100_000, 10_170, 10);
    expect(result).not.toBeNull();
    expect(result!.reduce((a, b) => a + b, 0)).toBe(500_000);
  });

  it('respects max_count', () => {
    const result = randomOutputsForTier(seedRng(), 500_000, 50_000, 10_170, 3);
    if (result) {
      expect(result.length).toBeLessThanOrEqual(3);
    }
  });

  it('every output is at least offset', () => {
    const offset = 10_170;
    const result = randomOutputsForTier(seedRng(), 500_000, 100_000, offset, 10);
    if (result) {
      for (const v of result) {
        expect(v).toBeGreaterThanOrEqual(offset);
      }
    }
  });
});

describe('allocateAllFeasibleTiers — registers every feasible tier', () => {
  const hello = makeHello({ tiers: [10_000, 100_000, 1_000_000] });

  // 6 distinct compressed pubkeys → minOutputs = max(11 - 6, 1) = 5
  const sixPubkeys = Array.from({ length: 6 }, (_, i) => {
    const pk = new Uint8Array(33);
    pk[0] = 0x02;
    pk[1] = i;
    return pk;
  });
  // Total: 6 × 30_000 = 180_000 sats
  const sumIn = 180_000;

  it('returns plans for all tiers the inputs can afford', () => {
    const rng = () => 0.5;
    const result = allocateAllFeasibleTiers(hello, sumIn, sixPubkeys, rng);
    // tier 10_000 should be feasible; 100_000 and 1_000_000 likely not
    expect(result.size).toBeGreaterThanOrEqual(1);
    expect(result.has(10_000)).toBe(true);
    for (const [, plan] of result) {
      // EC invariant: sumIn = inputFees + outputFees + Σvalues + excessFee
      const outputFees = plan.values.length * 34; // componentFee(34, 1000) = 34
      expect(
        plan.inputFees + outputFees + plan.values.reduce((a, b) => a + b, 0) + plan.excessFee
      ).toBe(sumIn);
      expect(plan.excessFee).toBeGreaterThanOrEqual(hello.minExcessFee);
      expect(plan.excessFee).toBeLessThanOrEqual(MAX_EXCESS_FEE);
    }
  });

  it('excludes tiers the inputs cannot cover', () => {
    const rng = () => 0.5;
    const result = allocateAllFeasibleTiers(hello, sumIn, sixPubkeys, rng);
    expect(result.has(1_000_000)).toBe(false);
  });
});

describe('buildServerRunner — shared runner for manual and auto', () => {
  beforeEach(() => {
    mockGatherInputs.mockReset();
    mockCreateFreshScripts.mockReset();
    mockInvoke.mockReset();
    mockCompleteFusionBroadcast.mockReset();
    mockTrackAttempt.mockReset();
    mockReservedOutpoints.mockReset();
    mockReservedOutpoints.mockReturnValue(new Set());
    mockReserveOutpoints.mockReset();
    mockReleaseOutpoints.mockReset();
    mockFetchFusionStatus.mockReset();
  });

  // Deterministic rng that produces values making ~6 outputs at tier 10k.
  // Needs to be deterministic so allocateAllFeasibleTiers always succeeds.
  const testRng = () => 0.5;
  // 6 distinct inputs × 30k each = 180k total.
  // With 6 distinct pubkeys, minOutputs = max(11-6,1) = 5.
  // inputFees ≈ 6 × 141 = 846. avail ≈ 179144. tier 10k → ~8-9 outputs.
  const makeInputs = () =>
    Array.from({ length: 6 }, (_, i) => ({
      prev_txid: (i + 10).toString(16).padStart(2, '0').repeat(32),
      prev_index: 0,
      pubkey: '02' + i.toString(16).padStart(2, '0') + '00'.repeat(31),
      value: 30_000,
      privkey: '01'.repeat(32),
    }));
  const makeCoins = () =>
    Array.from({ length: 6 }, (_, i) => ({
      tx_hash: (i + 10).toString(16).padStart(2, '0').repeat(32),
      tx_pos: 0,
      value: 30_000,
      address: `bchtest:q${i}`,
    })) as never[];
  const makeConfig = (overrides: Partial<Parameters<typeof buildServerRunner>[0]> = {}) =>
    buildServerRunner({
      walletId: 1,
      network: Network.CHIPNET,
      expectedHello: makeHello(),
      host: '127.0.0.1',
      port: 8787,
      useSsl: false,
      tor: null,
      _testRng: testRng,
      ...overrides,
    });

  it('rejects if fusion_run returns paused error', async () => {
    const runner = makeConfig({ tor: { host: '127.0.0.1', port: 9050 } });
    mockInvoke.mockResolvedValue({
      ready: false,
      message: 'CashFusion execution is paused',
    });

    await expect(runner(makeCoins())).rejects.toThrow('paused');
    expect(mockGatherInputs).not.toHaveBeenCalled();
  });

  it('does not report fused when the round lacks an exact txid and transaction', async () => {
    const runner = makeConfig();
    mockGatherInputs.mockResolvedValue(makeInputs());
    mockCreateFreshScripts.mockResolvedValue(Array(20).fill('76a914' + '00'.repeat(20) + '88ac'));
    installNativeMocks({
      ok: true,
      broadcast_verified: false,
      txid: null,
      tx_hex: null,
      message: 'signed transaction unavailable',
    });

    await expect(runner(makeCoins())).rejects.toThrow('unavailable');
    expect(mockCompleteFusionBroadcast).not.toHaveBeenCalled();
  });

  it('persists an assembled transaction before Tor relay and requires independent observation', async () => {
    const runner = makeConfig({
      tor: { host: '127.0.0.1', port: 9050 },
    });
    const txid = 'bc'.repeat(32);
    const txHex = '01000000';
    const order: string[] = [];
    mockGatherInputs.mockResolvedValue(makeInputs());
    mockCreateFreshScripts.mockResolvedValue(
      Array(20).fill('76a914' + '00'.repeat(20) + '88ac')
    );
    mockTrackAttempt.mockImplementation(async () => {
      order.push('track');
      return { txid };
    });
    mockInvoke.mockImplementation((command: string, args: unknown) => {
      order.push(command);
      if (command === 'fusion_execution_status') {
        return Promise.resolve({ ready: true, message: null });
      }
      if (
        command === 'fusion_prepare_round' ||
        command === 'fusion_cancel_round'
      ) {
        return Promise.resolve();
      }
      if (command === 'fusion_run') {
        return Promise.resolve({
          ok: true,
          broadcast_verified: false,
          txid,
          tx_hex: txHex,
          message: 'assembled',
        });
      }
      if (command === 'fusion_relay_broadcast_and_observe') {
        expect(args).toEqual({
          txHex,
          network: Network.CHIPNET,
          relayHost: 'chipnet.bitjson.com',
          relayPort: 48333,
          observerHost: 'seed.cbch.loping.net',
          observerPort: 48333,
          torHost: '127.0.0.1',
          torPort: 9050,
        });
        return Promise.resolve({
          txid,
          relaySubmitted: true,
          observerSeen: true,
        });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    mockCompleteFusionBroadcast.mockResolvedValue({
      tracked: true,
      refreshed: false,
      depthRecorded: 1,
    });

    await expect(runner(makeCoins())).resolves.toEqual({
      txid,
    });
    expect(order.indexOf('track')).toBeLessThan(
      order.indexOf('fusion_relay_broadcast_and_observe')
    );
    expect(mockCompleteFusionBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        txid,
        txHex,
        privacyRoute: 'tor-only',
      })
    );
  });

  it('reserves every server-round input before deriving keys and releases the temporary lock after durable tracking', async () => {
    const runner = makeConfig({
      tor: { host: '127.0.0.1', port: 9050 },
    });
    const coins = makeCoins();
    const order: string[] = [];
    mockReserveOutpoints.mockImplementation(() => order.push('reserve'));
    mockReleaseOutpoints.mockImplementation(() => order.push('release'));
    mockGatherInputs.mockImplementation(async () => {
      order.push('keys');
      return makeInputs();
    });
    mockCreateFreshScripts.mockResolvedValue(
      Array(20).fill('76a914' + '00'.repeat(20) + '88ac')
    );
    installNativeMocks({
      ok: true,
      broadcast_verified: false,
      txid: 'be'.repeat(32),
      tx_hex: '01000000',
      message: 'assembled',
    });
    mockCompleteFusionBroadcast.mockResolvedValue({
      tracked: true,
      refreshed: false,
      depthRecorded: 1,
    });

    await runner(coins);

    const expectedOutpoints = coins.map(
      (coin) => `${coin.tx_hash}:${coin.tx_pos}`
    );
    expect(mockReserveOutpoints).toHaveBeenCalledWith(1, expectedOutpoints);
    expect(order.indexOf('reserve')).toBeLessThan(order.indexOf('keys'));
    expect(mockReleaseOutpoints).toHaveBeenCalledWith(1, expectedOutpoints);
  });

  it('invokes cancel on AbortSignal fired during fusion_run', async () => {
    const runner = makeConfig();
    const controller = new AbortController();
    mockGatherInputs.mockResolvedValue(makeInputs());
    mockCreateFreshScripts.mockResolvedValue(Array(20).fill('76a914' + '00'.repeat(20) + '88ac'));

    let invokeResolve: (v: unknown) => void = () => {};
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'fusion_execution_status') {
        return Promise.resolve({ ready: true, message: null });
      }
      if (cmd === 'fusion_prepare_round' || cmd === 'fusion_cancel_round') {
        return Promise.resolve();
      }
      if (cmd === 'fusion_run') {
        return new Promise((resolve) => {
          invokeResolve = resolve;
          setTimeout(() => controller.abort(), 5);
        });
      }
      return Promise.resolve();
    });

    const promise = runner(makeCoins(), controller.signal);
    await new Promise((r) => setTimeout(r, 20));
    invokeResolve({ ok: false, broadcast_verified: false, txid: null, tx_hex: null, message: 'cancelled' });

    await expect(promise).rejects.toThrow();
    expect(mockInvoke).toHaveBeenCalledWith('fusion_cancel_round', expect.any(Object));
  });

  it('throws immediately when signal is already aborted before start', async () => {
    const runner = makeConfig();
    const controller = new AbortController();
    controller.abort();

    await expect(runner(makeCoins(), controller.signal)).rejects.toThrow('cancelled');
    expect(mockGatherInputs).not.toHaveBeenCalled();
  });

  it('passes expectedHello to fusion_run for live validation', async () => {
    const hello = makeHello({ tiers: [10_000] });
    const runner = makeConfig({ expectedHello: hello });
    mockGatherInputs.mockResolvedValue(makeInputs());
    mockCreateFreshScripts.mockResolvedValue(Array(20).fill('76a914' + '00'.repeat(20) + '88ac'));
    installNativeMocks({
      ok: true,
      broadcast_verified: true,
      txid: 'cc'.repeat(32),
      tx_hex: '01000000',
      message: 'ok',
    });
    mockCompleteFusionBroadcast.mockResolvedValue({ tracked: true, refreshed: true, depthRecorded: 1 });

    await runner(makeCoins());

    expect(mockInvoke).toHaveBeenCalledWith(
      'fusion_run',
      expect.objectContaining({
        expectedHello: hello,
        lookupHost: 'electrum-chipnet.optnlabs.com',
        lookupPort: 50002,
        lookupUseSsl: true,
      })
    );
  });

  it('fetches a fresh ServerHello inside every unpinned round attempt', async () => {
    const hello = {
      ...makeHello({ tiers: [10_000] }),
      donationAddress: null,
    };
    const onServerHello = vi.fn();
    const runner = makeConfig({
      expectedHello: undefined,
      onServerHello,
      inputLookupEndpoint: {
        host: 'lookup.example',
        port: 51002,
        useSsl: true,
      },
    });
    mockFetchFusionStatus.mockResolvedValue(hello);
    mockGatherInputs.mockResolvedValue(makeInputs());
    mockCreateFreshScripts.mockResolvedValue(
      Array(20).fill('76a914' + '00'.repeat(20) + '88ac')
    );
    installNativeMocks({
      ok: true,
      broadcast_verified: true,
      txid: 'ce'.repeat(32),
      tx_hex: '01000000',
      message: 'ok',
    });
    mockCompleteFusionBroadcast.mockResolvedValue({
      tracked: true,
      refreshed: true,
      depthRecorded: 1,
    });

    await runner(makeCoins());

    expect(mockFetchFusionStatus).toHaveBeenCalledWith(
      '127.0.0.1',
      8787,
      false,
      undefined
    );
    expect(onServerHello).toHaveBeenCalledWith(hello);
    expect(mockInvoke).toHaveBeenCalledWith(
      'fusion_run',
      expect.objectContaining({
        expectedHello: hello,
        lookupHost: 'lookup.example',
        lookupPort: 51002,
        lookupUseSsl: true,
      })
    );
  });

  it('prepares cancellation before deriving keys and sends every feasible plan', async () => {
    const runner = makeConfig();
    const order: string[] = [];
    mockGatherInputs.mockImplementation(async () => {
      order.push('keys');
      return makeInputs();
    });
    mockCreateFreshScripts.mockResolvedValue(
      Array(20).fill('76a914' + '00'.repeat(20) + '88ac')
    );
    mockInvoke.mockImplementation((command: string, args: unknown) => {
      order.push(command);
      if (command === 'fusion_execution_status') {
        return Promise.resolve({ ready: true, message: null });
      }
      if (command === 'fusion_prepare_round') return Promise.resolve();
      if (command === 'fusion_run') {
        expect(args).toEqual(
          expect.objectContaining({
            tierPlans: expect.arrayContaining([
              expect.objectContaining({ tier: 10_000 }),
            ]),
            outputScripts: expect.any(Array),
          })
        );
        return Promise.resolve({
          ok: true,
          broadcast_verified: true,
          txid: 'dd'.repeat(32),
          tx_hex: '01000000',
          message: 'ok',
        });
      }
      if (command === 'fusion_relay_broadcast_and_observe') {
        return Promise.resolve({
          txid: 'dd'.repeat(32),
          relaySubmitted: true,
          observerSeen: true,
        });
      }
      return Promise.resolve();
    });
    mockTrackAttempt.mockResolvedValue({ txid: 'dd'.repeat(32) });
    mockCompleteFusionBroadcast.mockResolvedValue({
      tracked: true,
      refreshed: true,
      depthRecorded: 1,
    });

    await runner(makeCoins());

    expect(order.indexOf('fusion_execution_status')).toBeLessThan(
      order.indexOf('fusion_prepare_round')
    );
    expect(order.indexOf('fusion_prepare_round')).toBeLessThan(
      order.indexOf('keys')
    );
  });
});
