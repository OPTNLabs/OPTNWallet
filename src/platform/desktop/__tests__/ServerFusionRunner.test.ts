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
// Native tier planning answers on its own, so each test's command mock only
// has to describe the round.
const mockAllocateTiers = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) =>
    command === 'fusion_allocate_tiers'
      ? mockAllocateTiers(args)
      : mockInvoke(command, args),
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
  buildServerRunner,
  parseElectrumLookupEndpoint,
  inputLookupEndpoints,
  parseFusionServerTarget,
  serverFusionPrivacyDestination,
  type ServerHelloSnapshot,
} from '../ServerFusionRunner';
import { Network } from '../../../state/slices/networkSlice';

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

  it('still resolves Tor for a remote lookup behind a local Fusion server', () => {
    expect(
      serverFusionPrivacyDestination('localhost', 'electrum.example')
    ).toBe('electrum.example');
    expect(
      serverFusionPrivacyDestination('fusion.example', 'electrum.example')
    ).toBe('fusion.example');
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
    // Prefer Electrum is_known (fast path after server broadcast).
    if (command === 'fusion_transaction_is_known' && txid) {
      return Promise.resolve(true);
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
    mockAllocateTiers.mockReset();
    mockAllocateTiers.mockResolvedValue(PLANS);
  });

  // What native planning returns for six 30k inputs: tier 10k, nine outputs
  // at most. Planning itself is tested in crates/optn-fusion (allocate.rs).
  const PLANS = [
    { tier: 10_000, outputValues: Array(9).fill(19_000), excessFee: 93 },
    { tier: 12_000, outputValues: Array(7).fill(24_000), excessFee: 41 },
  ];
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
      ...overrides,
    });

  it('plans natively from public keys and values only, and runs those plans', async () => {
    const runner = makeConfig({ onlyTiers: [10_000] });
    mockGatherInputs.mockResolvedValue(makeInputs());
    mockCreateFreshScripts.mockResolvedValue(
      Array(9).fill('76a914' + '00'.repeat(20) + '88ac')
    );
    installNativeMocks({
      ok: true,
      broadcast_verified: true,
      txid: 'cd'.repeat(32),
      tx_hex: '01000000',
      message: 'ok',
    });
    mockCompleteFusionBroadcast.mockResolvedValue({
      tracked: true,
      refreshed: true,
      depthRecorded: 1,
    });

    await runner(makeCoins());

    expect(mockAllocateTiers).toHaveBeenCalledWith({
      expectedHello: makeHello(),
      inputs: makeInputs().map(({ pubkey, value }) => ({ pubkey, value })),
      onlyTiers: [10_000],
    });
    // Private keys never cross for planning.
    expect(JSON.stringify(mockAllocateTiers.mock.calls)).not.toContain('privkey');
    // Enough fresh scripts for the largest plan, and the plans unchanged.
    expect(mockCreateFreshScripts).toHaveBeenCalledWith(1, Network.CHIPNET, 9);
    expect(mockInvoke).toHaveBeenCalledWith(
      'fusion_run',
      expect.objectContaining({ tierPlans: PLANS })
    );
  });

  it('stops on a planning refusal before any address or round', async () => {
    const runner = makeConfig({ onlyTiers: [1_000_000] });
    mockGatherInputs.mockResolvedValue(makeInputs());
    installNativeMocks();
    // Tauri rejects with the native error string.
    mockAllocateTiers.mockRejectedValue(
      'Selected inputs cannot fund the requested tier(s): 1000000 sats.'
    );

    await expect(runner(makeCoins())).rejects.toBe(
      'Selected inputs cannot fund the requested tier(s): 1000000 sats.'
    );
    expect(mockCreateFreshScripts).not.toHaveBeenCalled();
    const commands = mockInvoke.mock.calls.map((call) => call[0]);
    expect(commands).not.toContain('fusion_run');
    // The temporary reservation is released: nothing was disclosed.
    expect(mockReleaseOutpoints).toHaveBeenCalled();
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

  // Relay-and-observe only proves anything when WE announce first. In a
  // server-coordinated round the Fusion server broadcasts before we relay, so
  // nodes already hold the transaction and never re-announce it. Treating the
  // missing echo as failure marked genuinely-confirmed fusions as failed —
  // observed against a transaction that was on chain at the time.
  const runObservationCase = async (
    observerSeen: boolean,
    known: boolean | Error
  ) => {
    const runner = makeConfig({ tor: { host: '127.0.0.1', port: 9050 } });
    const txid = 'bc'.repeat(32);
    mockGatherInputs.mockResolvedValue(makeInputs());
    mockCreateFreshScripts.mockResolvedValue(
      Array(20).fill('76a914' + '00'.repeat(20) + '88ac')
    );
    mockTrackAttempt.mockResolvedValue({ txid });
    mockCompleteFusionBroadcast.mockResolvedValue({
      tracked: true,
      refreshed: false,
      depthRecorded: 1,
    });
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'fusion_execution_status') {
        return Promise.resolve({ ready: true, message: null });
      }
      if (command === 'fusion_prepare_round' || command === 'fusion_cancel_round') {
        return Promise.resolve();
      }
      if (command === 'fusion_run') {
        return Promise.resolve({
          ok: true,
          broadcast_verified: false,
          txid,
          tx_hex: '01000000',
          message: 'assembled',
        });
      }
      if (command === 'fusion_relay_broadcast_and_observe') {
        return Promise.resolve({ txid, relaySubmitted: true, observerSeen });
      }
      if (command === 'fusion_transaction_is_known') {
        return known instanceof Error
          ? Promise.reject(known)
          : Promise.resolve(known);
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    return { runner, txid };
  };

  it('accepts a round the network already has without dual-peer Tor observe', async () => {
    const { runner, txid } = await runObservationCase(false, true);
    await expect(runner(makeCoins())).resolves.toEqual({ txid });
    expect(mockCompleteFusionBroadcast).toHaveBeenCalled();
    // known=true → backup dual-peer path must not run
    const commands = mockInvoke.mock.calls.map((c) => c[0]);
    expect(commands).toContain('fusion_transaction_is_known');
    expect(commands).not.toContain('fusion_relay_broadcast_and_observe');
  });

  it('still fails when no peer echoed it and no server has it', async () => {
    const { runner } = await runObservationCase(false, false);
    await expect(runner(makeCoins())).rejects.toThrow(
      'not independently observed'
    );
  });

  it('does not accept a round because the confirmation lookup itself failed', async () => {
    // An unreachable Electrum says nothing about whether the transaction exists.
    // Treating that as confirmation would report success for a fusion that may
    // never have been broadcast at all.
    const { runner } = await runObservationCase(
      false,
      new Error('Electrum unreachable')
    );
    await expect(runner(makeCoins())).rejects.toThrow(
      'not independently observed'
    );
  });

  it('persists the tx before confirmation and uses Electrum is_known first', async () => {
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
    mockInvoke.mockImplementation((command: string) => {
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
      if (command === 'fusion_transaction_is_known') {
        return Promise.resolve(true);
      }
      if (command === 'fusion_relay_broadcast_and_observe') {
        return Promise.reject(new Error('should not dual-peer observe when known'));
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
      order.indexOf('fusion_transaction_is_known')
    );
    expect(order).not.toContain('fusion_relay_broadcast_and_observe');
    expect(mockCompleteFusionBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        txid,
        txHex,
        privacyRoute: 'tor-only',
      })
    );
  });

  it('falls back to Tor relay when Electrum does not have the tx yet', async () => {
    const { runner, txid } = await runObservationCase(true, false);
    // First is_known false; observe succeeds → complete without second is_known.
    // Override: is_known always false, observe true.
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'fusion_execution_status') {
        return Promise.resolve({ ready: true, message: null });
      }
      if (command === 'fusion_prepare_round' || command === 'fusion_cancel_round') {
        return Promise.resolve();
      }
      if (command === 'fusion_run') {
        return Promise.resolve({
          ok: true,
          broadcast_verified: false,
          txid,
          tx_hex: '01000000',
          message: 'assembled',
        });
      }
      if (command === 'fusion_transaction_is_known') {
        return Promise.resolve(false);
      }
      if (command === 'fusion_relay_broadcast_and_observe') {
        return Promise.resolve({
          txid,
          relaySubmitted: true,
          observerSeen: true,
        });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    await expect(runner(makeCoins())).resolves.toEqual({ txid });
    expect(mockCompleteFusionBroadcast).toHaveBeenCalled();
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

  it('passes expectedHello and the exact Auto inactivity policy to fusion_run', async () => {
    const hello = makeHello({ tiers: [10_000] });
    const runner = makeConfig({
      expectedHello: hello,
      joinInactiveTimeoutMs: 600_000,
    });
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
        joinInactiveTimeoutMs: 600_000,
      })
    );
  });

  it('requests a live ServerHello for an unpinned round attempt', async () => {
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
      if (command === 'fusion_transaction_is_known') {
        return Promise.resolve(true);
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

describe('fusion server scheme defaults', () => {
  it('uses plain TCP for a local server, because server.py has no TLS', () => {
    // Defaulting loopback to SSL produced "TLS handshake failed: tls handshake
    // eof" against a perfectly healthy local Electron Cash server, which reads
    // as a broken server rather than as us speaking the wrong protocol at it.
    expect(parseFusionServerTarget('127.0.0.1:8787')).toEqual({
      host: '127.0.0.1',
      port: 8787,
      useSsl: false,
    });
    expect(parseFusionServerTarget('localhost:8787').useSsl).toBe(false);
  });

  it('still defaults a remote server to SSL', () => {
    // Sending fusion traffic to the internet in the clear is the worse mistake.
    expect(parseFusionServerTarget('fusion.servo.cash:8789').useSsl).toBe(true);
  });

  it('lets an explicit suffix override both defaults', () => {
    expect(parseFusionServerTarget('127.0.0.1:8787:s').useSsl).toBe(true);
    expect(parseFusionServerTarget('fusion.servo.cash:8789:t').useSsl).toBe(false);
  });
});

describe('input lookup endpoints', () => {
  // Peer-input verification used to dial one fixed server. When chipnet's first
  // configured server stopped answering over Tor, every round reached
  // StartRound and aborted — a lookup failure cannot be blamed on the peer, so
  // the only safe move is to abandon the round. Offering the rest as fallbacks
  // is what keeps one dead host from being fatal.
  it('offers more than one server so a single dead host is survivable', () => {
    const endpoints = inputLookupEndpoints(Network.CHIPNET);
    expect(endpoints.length).toBeGreaterThan(1);
  });

  it('tries the caller-preferred server first', () => {
    const preferred = { host: 'my-own-node.example', port: 50002, useSsl: true };
    const endpoints = inputLookupEndpoints(Network.CHIPNET, preferred);
    expect(endpoints[0]).toEqual(preferred);
    expect(endpoints.length).toBeGreaterThan(1);
  });

  it('does not retry the same server twice', () => {
    const configured = inputLookupEndpoints(Network.CHIPNET);
    // Preferring a server that is already configured must not duplicate it:
    // retrying an unreachable host costs another full timeout for nothing.
    const endpoints = inputLookupEndpoints(Network.CHIPNET, configured[1]);
    const keys = endpoints.map((e) => `${e.host}:${e.port}:${e.useSsl}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(endpoints[0]).toEqual(configured[1]);
  });
});
