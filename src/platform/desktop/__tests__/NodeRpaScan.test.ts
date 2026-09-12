import { beforeEach, expect, it, vi } from 'vitest';
import { Network } from '../../../state/slices/networkSlice';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  birth: vi.fn(),
  route: vi.fn(),
  wallet: 7,
  target: 'selected-node:48333',
  tor: true,
  torPort: 9050,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../../state/store', () => ({ store: { getState: () => ({}) } }));
vi.mock('../../../state/slices/walletSlice', () => ({
  selectWalletId: () => mocks.wallet,
}));
vi.mock('../../../state/selectors/networkSelectors', () => ({
  selectCurrentNetwork: () => 'chipnet',
}));
vi.mock('../../../state/slices/experimentalSlice', () => ({
  selectTorEnabled: () => mocks.tor,
  selectTorAuto: () => true,
  selectTorHost: () => '127.0.0.1',
  selectTorPortManual: () => mocks.torPort,
}));
vi.mock('../backendSelection', () => ({ activeNode: () => mocks.target }));
vi.mock('../DesktopWalletManager', () => ({ getBirthHeight: mocks.birth }));
vi.mock('../FusionTorResolver', () => ({
  resolveFusionTransport: mocks.route,
}));
vi.mock('../../../utils/servers/userNodes', () => ({
  parseNodeTarget: () => ({ host: 'selected-node', port: 48333 }),
}));
import { scanNodeRpa } from '../NodeRpaScan';

const keys = () => ({
  scanPrivkey: new Uint8Array(32).fill(1),
  scanPubkey: new Uint8Array(33),
  spendPrivkey: new Uint8Array(32),
  spendPubkey: new Uint8Array(33).fill(2),
});
const receipt = {
  txid: 'ab'.repeat(32),
  vout: 0,
  address: 'bchtest:qexample',
  value_sats: 50002,
  block_height: 100,
  unspent: true,
  token: null,
  prevout_txid: 'cd'.repeat(32),
  prevout_index: 2,
  sender_pubkey_hex: '02' + '11'.repeat(32),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.wallet = 7;
  mocks.target = 'selected-node:48333';
  mocks.tor = true;
  mocks.torPort = 9050;
  mocks.birth.mockResolvedValue(90);
  mocks.route.mockResolvedValue({
    type: 'tor',
    tor: { host: '127.0.0.1', port: 9050 },
  });
  mocks.invoke.mockResolvedValue({
    includes_mempool: false,
    receipts: [
      receipt,
      { ...receipt, vout: 1, token: { amount: '1' } },
      { ...receipt, vout: 2, unspent: false },
    ],
  });
});

it('uses the exact node and public Rust receipts, preserving spending origin without BCH-selecting tokens', async () => {
  const result = await scanNodeRpa(7, Network.CHIPNET, keys());
  expect(mocks.invoke).toHaveBeenCalledWith(
    'cashcode_scan_node',
    expect.objectContaining({
      host: 'selected-node',
      port: 48333,
      fromHeight: 90,
      torRequired: true,
      torHost: '127.0.0.1',
      torPort: 9050,
    })
  );
  expect(result.unspentSats).toBe(50002);
  expect(result.unspentOutputs).toHaveLength(1);
  expect(result.unspentOutputs[0].rpaOrigin).toEqual({
    prevoutTxid: receipt.prevout_txid,
    prevoutIndex: 2,
    senderPubkey: receipt.sender_pubkey_hex,
  });
  expect(result.error).toMatch(/unconfirmed/);
  expect(mocks.invoke.mock.calls[0][1].scanPrivate).toEqual(Array(32).fill(0));
});

it('scans from the beginning when the birthday is unknown', async () => {
  mocks.birth.mockResolvedValue(null);
  await scanNodeRpa(7, Network.CHIPNET, keys());
  expect(mocks.invoke.mock.calls[0][1].fromHeight).toBe(1);
});

it('does not connect without required Tor', async () => {
  mocks.route.mockResolvedValue({
    type: 'unavailable',
    reason: 'Tor unavailable',
  });
  await expect(scanNodeRpa(7, Network.CHIPNET, keys())).rejects.toThrow(
    /Tor unavailable/
  );
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('does not publish results into a switched wallet', async () => {
  mocks.invoke.mockImplementation(async () => {
    mocks.wallet = 8;
    return { receipts: [] };
  });
  await expect(scanNodeRpa(7, Network.CHIPNET, keys())).rejects.toThrow(
    /changed during/
  );
});

it('does not start a scan after the selected source changes while loading its birthday', async () => {
  mocks.birth.mockImplementationOnce(async () => {
    mocks.target = 'other-node:48333';
    return 90;
  });
  await expect(scanNodeRpa(7, Network.CHIPNET, keys())).rejects.toThrow(
    /changed during/
  );
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('does not publish results after changing the Tor proxy', async () => {
  mocks.invoke.mockImplementationOnce(async () => {
    mocks.torPort = 9150;
    return { receipts: [] };
  });
  await expect(scanNodeRpa(7, Network.CHIPNET, keys())).rejects.toThrow(
    /changed during/
  );
});
