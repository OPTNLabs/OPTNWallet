import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVirtualMachineBCH,
  decodeTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import type { WalletKitTypes } from '@reown/walletkit';
import type { RootState } from '../../../state/store';
import { Network } from '../../../state/slices/networkSlice';
import {
  connectorP2pkhLock,
  connectorPublicKey,
  signConnectorP2pkh,
} from '../../../services/connect/ConnectSigningCore';

const mocks = vi.hoisted(() => ({
  retrieveKeys: vi.fn(),
  fetchAddressPrivateKey: vi.fn(),
  broadcast: vi.fn(),
}));
vi.mock('../../../services/KeyService', () => ({ default: mocks }));
vi.mock('../../../services/TransactionService', () => ({
  default: { sendTransaction: mocks.broadcast },
}));
vi.mock('../../../services/hardware/TrezorService', () => ({
  trezorSignTransaction: vi.fn(),
  pathToAddressN: vi.fn(),
}));
vi.mock('../../../services/hardware/LedgerService', () => ({
  ledgerSignTransaction: vi.fn(),
}));
vi.mock('../../../services/ElectrumAdapter', () => ({ default: vi.fn() }));

import { signWalletConnectTransactionRequest } from '../signing';

const key = hexToBin('00'.repeat(31) + '01');
const otherKey = hexToBin('00'.repeat(31) + '02');
const lock = connectorP2pkhLock(connectorPublicKey(key));
const address = lockingBytecodeToCashAddress({
  prefix: 'bchtest',
  bytecode: lock,
});
if (typeof address === 'string') throw new Error(address);
const state = {
  wallet_id: { currentWalletId: 1 },
  network: { currentNetwork: Network.CHIPNET },
} as RootState;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.retrieveKeys.mockResolvedValue([{ address: address.address }]);
  mocks.fetchAddressPrivateKey.mockImplementation(async () => key.slice());
});

function request() {
  const sourceOutputs = [
    { lockingBytecode: lock, valueSatoshis: 100_000n },
    {
      lockingBytecode: connectorP2pkhLock(connectorPublicKey(otherKey)),
      valueSatoshis: 5000n,
    },
  ];
  const transaction = {
    version: 2,
    locktime: 0,
    inputs: [0, 1].map((index) => ({
      outpointTransactionHash: new Uint8Array(32).fill(index + 1),
      outpointIndex: index,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: new Uint8Array(),
    })),
    outputs: [{ lockingBytecode: lock, valueSatoshis: 104_000n }],
  };
  transaction.inputs[1].unlockingBytecode = signConnectorP2pkh(
    { inputIndex: 1, transaction, sourceOutputs },
    otherKey
  );
  return { transaction, sourceOutputs, broadcast: false };
}

function envelope(
  params: ReturnType<typeof request>
): WalletKitTypes.SessionRequest {
  return {
    id: 1,
    topic: 'test-session',
    params: { request: { method: 'bch_signTransaction', params } },
  } as unknown as WalletKitTypes.SessionRequest;
}

describe('WalletConnect shared Rust signing path', () => {
  it('signs the wallet input, preserves a peer signature and leaves the approved payload unchanged', async () => {
    const payload = request();
    const peerSignature =
      payload.transaction.inputs[1].unlockingBytecode.slice();
    const result = await signWalletConnectTransactionRequest(
      envelope(payload),
      state
    );
    const transaction = decodeTransaction(
      hexToBin(result.signedTxObject.signedTransaction)
    );
    if (typeof transaction === 'string') throw new Error(transaction);
    expect(transaction.inputs[0].unlockingBytecode[65]).toBe(0x61);
    expect(transaction.inputs[1].unlockingBytecode).toEqual(peerSignature);
    expect(payload.transaction.inputs[0].unlockingBytecode).toHaveLength(0);
    expect(
      createVirtualMachineBCH().verify({
        transaction,
        sourceOutputs: payload.sourceOutputs,
      })
    ).toBe(true);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('rejects an incomplete source list before accessing private keys', async () => {
    const payload = request();
    payload.sourceOutputs.pop();
    await expect(
      signWalletConnectTransactionRequest(envelope(payload), state)
    ).rejects.toThrow('Malformed');
    expect(mocks.fetchAddressPrivateKey).not.toHaveBeenCalled();
  });
});
