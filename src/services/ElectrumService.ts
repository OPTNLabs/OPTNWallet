import ElectrumServer from '../apis/ElectrumServer/ElectrumServer';
import { RequestResponse } from 'electrum-cash';
import { TransactionHistoryItem, UTXO } from '../types/types';

// Type guard to check if response is UTXO[]
function isUTXOArray(response: RequestResponse): response is UTXO[] {
  return (
    Array.isArray(response) &&
    response.every(
      (item) => 'tx_hash' in item && 'height' in item && 'value' in item
    )
  );
}

// Type guard to check if response is TransactionHistoryItem[]
function isTransactionHistoryArray(
  response: RequestResponse
): response is TransactionHistoryItem[] {
  return (
    Array.isArray(response) &&
    response.every((item) => 'tx_hash' in item && 'height' in item)
  );
}

// Type guard to check if response is a string (for transaction hashes)
function isStringResponse(response: RequestResponse): response is string {
  return typeof response === 'string';
}

const ElectrumService = {
  async getUTXOS(address: string): Promise<UTXO[]> {
    const server = ElectrumServer();
    try {
      const UTXOs: RequestResponse = await server.request(
        'blockchain.address.listunspent',
        address
      );

      if (isUTXOArray(UTXOs)) {
        // console.log(`Fetched UTXOs for address ${address}:`, UTXOs);
        return UTXOs;
      } else {
        throw new Error('Invalid UTXO response format');
      }
    } catch (error) {
      console.error('Error fetching UTXOs:', error);
      return [];
    }
  },

  async getBalance(address: string): Promise<number> {
    const server = ElectrumServer();
    try {
      const response: any = await server.request(
        'blockchain.address.get_balance',
        address,
        'include_tokens'
      );
      // console.log('Get Balance response:', response);

      if (
        response &&
        typeof response.confirmed === 'number' &&
        typeof response.unconfirmed === 'number'
      ) {
        const { confirmed, unconfirmed } = response;
        return confirmed + unconfirmed;
      } else {
        throw new Error('Unexpected response format');
      }
    } catch (error) {
      console.error('Error getting balance:', error);
      return 0;
    }
  },

  async broadcastTransaction(txHex: string): Promise<string> {
    const server = ElectrumServer();
    try {
      const txHash: RequestResponse = await server.request(
        'blockchain.transaction.broadcast',
        txHex
      );

      if (isStringResponse(txHash)) {
        console.log(`Broadcasted transaction: ${txHash}`);
        return txHash;
      } else {
        throw new Error('Invalid transaction hash response format');
      }
    } catch (error) {
      console.error('Error broadcasting transaction:', error);
      return error.message || 'Unknown error';
    }
  },

  async getTransactionHistory(
    address: string
  ): Promise<TransactionHistoryItem[] | null> {
    const server = ElectrumServer();
    try {
      if (!address) {
        throw new Error('Invalid address: Address cannot be undefined');
      }

      // console.log(`Fetching transaction history for address: ${address}`);
      const history: RequestResponse = await server.request(
        'blockchain.address.get_history',
        address
      );

      if (isTransactionHistoryArray(history)) {
        // console.log(
        //   `Fetched transaction history for address ${address}:`,
        //   history
        // );
        return history;
      } else {
        throw new Error('Invalid transaction history response format');
      }
    } catch (error) {
      console.error('Error fetching transaction history:', error);
      return null;
    }
  },

  async subscribeAddress(address: string, callback: (status: string) => void) {
    const server = await ElectrumServer().electrumConnect();
    try {
      const status: RequestResponse = await server.request(
        'blockchain.address.subscribe',
        address
      );

      if (isStringResponse(status)) {
        console.log(`Subscribed to address: ${address}, status: ${status}`);
        // Here, you would set up the callback mechanism to listen for notifications.
        server.on('notification', (method: string, params: any[]) => {
          if (
            method === 'blockchain.address.subscribe' &&
            params[0] === address
          ) {
            callback(params[1]);
          }
        });
      } else {
        throw new Error('Invalid subscription response format');
      }
    } catch (error) {
      console.error('Error subscribing to address:', error);
    }
  },

  async subscribeBlockHeaders(callback: (header: any) => void) {
    const server = await ElectrumServer().electrumConnect();
    try {
      await server.request('blockchain.headers.subscribe');

      console.log('Subscribed to block headers');
      // Set up callback for block header notifications
      server.on('notification', (method: string, params: any[]) => {
        if (method === 'blockchain.headers.subscribe') {
          callback(params[0]);
        }
      });
    } catch (error) {
      console.error('Error subscribing to block headers:', error);
    }
  },

  async subscribeTransaction(
    txHash: string,
    callback: (height: number) => void
  ) {
    const server = await ElectrumServer().electrumConnect();
    try {
      const height: RequestResponse = await server.request(
        'blockchain.transaction.subscribe',
        txHash
      );

      if (typeof height === 'number') {
        console.log(`Subscribed to transaction: ${txHash}, height: ${height}`);
        // Set up callback for transaction notifications
        server.on('notification', (method: string, params: any[]) => {
          if (
            method === 'blockchain.transaction.subscribe' &&
            params[0] === txHash
          ) {
            callback(params[1]);
          }
        });
      } else {
        throw new Error('Invalid transaction subscription response format');
      }
    } catch (error) {
      console.error('Error subscribing to transaction:', error);
    }
  },

  async subscribeDoubleSpendProof(
    txHash: string,
    callback: (dsProof: any) => void
  ) {
    const server = await ElectrumServer().electrumConnect();
    try {
      await server.request('blockchain.transaction.dsproof.subscribe', txHash);

      console.log(
        `Subscribed to double-spend proof for transaction: ${txHash}`
      );
      // Set up callback for double-spend proof notifications
      server.on('notification', (method: string, params: any[]) => {
        if (
          method === 'blockchain.transaction.dsproof.subscribe' &&
          params[0] === txHash
        ) {
          callback(params[1]);
        }
      });
    } catch (error) {
      console.error('Error subscribing to double-spend proof:', error);
    }
  },

  async unsubscribeAddress(address: string): Promise<boolean> {
    const server = await ElectrumServer().electrumConnect();
    try {
      const result: RequestResponse = await server.request(
        'blockchain.address.unsubscribe',
        address
      );
      return result === true;
    } catch (error) {
      console.error('Error unsubscribing from address:', error);
      return false;
    }
  },

  async unsubscribeBlockHeaders(): Promise<boolean> {
    const server = await ElectrumServer().electrumConnect();
    try {
      const result: RequestResponse = await server.request(
        'blockchain.headers.unsubscribe'
      );
      return result === true;
    } catch (error) {
      console.error('Error unsubscribing from block headers:', error);
      return false;
    }
  },

  async unsubscribeTransaction(txHash: string): Promise<boolean> {
    const server = await ElectrumServer().electrumConnect();
    try {
      const result: RequestResponse = await server.request(
        'blockchain.transaction.unsubscribe',
        txHash
      );
      return result === true;
    } catch (error) {
      console.error('Error unsubscribing from transaction:', error);
      return false;
    }
  },

  async unsubscribeDoubleSpendProof(txHash: string): Promise<boolean> {
    const server = await ElectrumServer().electrumConnect();
    try {
      const result: RequestResponse = await server.request(
        'blockchain.transaction.dsproof.unsubscribe',
        txHash
      );
      return result === true;
    } catch (error) {
      console.error('Error unsubscribing from double-spend proof:', error);
      return false;
    }
  },
};

export default ElectrumService;
