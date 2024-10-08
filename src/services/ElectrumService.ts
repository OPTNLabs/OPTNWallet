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
        console.log(`Fetched UTXOs for address ${address}:`, UTXOs);
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
      console.log('Get Balance response:', response);

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

      console.log(`Fetching transaction history for address: ${address}`);
      const history: RequestResponse = await server.request(
        'blockchain.address.get_history',
        address
      );

      if (isTransactionHistoryArray(history)) {
        console.log(
          `Fetched transaction history for address ${address}:`,
          history
        );
        return history;
      } else {
        throw new Error('Invalid transaction history response format');
      }
    } catch (error) {
      console.error('Error fetching transaction history:', error);
      return null;
    }
  },
};

export default ElectrumService;
