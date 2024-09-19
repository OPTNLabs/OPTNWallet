import {
  ElectrumClient,
  ElectrumTransport,
  RequestResponse,
} from 'electrum-cash';
import {
  chipnetServers,
  mainnetServers,
} from '../../utils/servers/ElectrumServers';
import { store } from '../../redux/store';
import { Network } from '../../redux/networkSlice';
import { TransactionHistoryItem, UTXO } from '../../types/types';

const testServer = chipnetServers[0];
const mainServer = mainnetServers[0];

let electrum: ElectrumClient | null = null;

function getCurrentServer(): string {
  const state = store.getState();
  const currentNetwork = state.network.currentNetwork;

  return currentNetwork === Network.MAINNET ? mainServer : testServer;
}

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

export default function ElectrumService() {
  async function electrumConnect(
    server: string = getCurrentServer()
  ): Promise<ElectrumClient> {
    if (electrum) {
      console.log('Reusing existing Electrum connection');
      return electrum;
    }

    electrum = new ElectrumClient(
      'OPTNWallet',
      '1.5.3',
      server,
      ElectrumTransport.WSS.Port,
      ElectrumTransport.WSS.Scheme
    );

    await electrum.connect();
    console.log('Connected to Electrum server');
    return electrum;
  }

  async function electrumDisconnect(): Promise<boolean> {
    if (electrum) {
      await electrum.disconnect(true);
      console.log('Disconnected from Electrum server');
      electrum = null;
      return true;
    }
    return false;
  }

  async function getUTXOS(address: string): Promise<UTXO[]> {
    const electrum = await electrumConnect();
    try {
      const UTXOs: RequestResponse = await electrum.request(
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
  }

  async function getBalance(address: string): Promise<number> {
    const electrum = await electrumConnect();
    try {
      const params = [address, 'include_tokens'];
      const response: any = await electrum.request(
        'blockchain.address.get_balance',
        ...params
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
    } finally {
      // Keep the connection open for subsequent requests
    }
  }

  async function broadcastTransaction(tx_hex: string): Promise<string> {
    const electrum = await electrumConnect();
    try {
      const tx_hash: RequestResponse = await electrum.request(
        'blockchain.transaction.broadcast',
        tx_hex
      );

      if (isStringResponse(tx_hash)) {
        console.log(`Broadcasted transaction: ${tx_hash}`);
        return tx_hash;
      } else {
        throw new Error('Invalid transaction hash response format');
      }
    } catch (error) {
      console.error('Error broadcasting transaction:', error);
      return error.message || 'Unknown error';
    }
  }

  async function getTransactionHistory(
    address: string
  ): Promise<TransactionHistoryItem[] | null> {
    const electrum = await electrumConnect();
    try {
      if (!address) {
        throw new Error('Invalid address: Address cannot be undefined');
      }
      console.log(`Fetching transaction history for address: ${address}`);
      const history: RequestResponse = await electrum.request(
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
  }

  return {
    electrumConnect,
    electrumDisconnect,
    getBalance,
    getUTXOS,
    broadcastTransaction,
    getTransactionHistory,
  };
}
