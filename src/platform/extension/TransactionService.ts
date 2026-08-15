import BaseTransactionService from '../../services/TransactionService';
import type { BroadcastResult } from '../../services/TransactionService';

export type {
  BroadcastResult,
  BroadcastState,
  BatchedTransactionRequest,
  SendTransactionOptions,
} from '../../services/TransactionService';

export const EXTENSION_VIEWER_BROADCAST_ERROR =
  'Sending is unavailable in the browser viewer. Use the desktop or mobile wallet to sign and broadcast.';

const denyBroadcast: typeof BaseTransactionService.sendTransaction =
  async (): Promise<BroadcastResult> => ({
    txid: null,
    errorMessage: EXTENSION_VIEWER_BROADCAST_ERROR,
  });

const denyBroadcastBatch: typeof BaseTransactionService.sendTransactionBatch =
  async (): Promise<BroadcastResult[]> => [
    {
      txid: null,
      errorMessage: EXTENSION_VIEWER_BROADCAST_ERROR,
    },
  ];

// Preserve every read/build method with the original singleton as its receiver,
// while replacing both broadcast entry points with fail-closed implementations.
// The extension build swaps all TransactionService imports to this module.
const instance = new Proxy(BaseTransactionService, {
  get(target, property, receiver) {
    if (property === 'sendTransaction') return denyBroadcast;
    if (property === 'sendTransactionBatch') return denyBroadcastBatch;

    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

export default instance;
