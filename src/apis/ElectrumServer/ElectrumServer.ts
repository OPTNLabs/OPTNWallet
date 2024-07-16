// src/apis/ElectrumServer/ElectrumServer.ts
import { ElectrumClient, ElectrumTransport } from 'electrum-cash';
import { chipnetServers } from '../../utils/servers/ElectrumServers';
import { BalanceResponse } from '../interfaces';

export enum Network {
  CHIPNET,
}

const testServer = chipnetServers[0];

let electrum: ElectrumClient | null = null;

export default function ElectrumService() {
  async function electrumConnect(
    server: string = testServer
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

  async function getUTXOS(address: string): Promise<any> {
    const electrum = await electrumConnect();
    try {
      console.log(`Fetching UTXOs for address: ${address}`);
      const UTXOs = await electrum.request(
        'blockchain.address.listunspent',
        address
      );
      console.log(`Fetched UTXOs for address ${address}:`, UTXOs);
      if (UTXOs) {
        return UTXOs;
      }
      return [];
    } finally {
      // Keep the connection open for subsequent requests
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
        const { confirmed, unconfirmed } = response as BalanceResponse;
        return confirmed + unconfirmed;
      } else {
        throw new Error('Unexpected response format');
      }
    } finally {
      // Keep the connection open for subsequent requests
    }
  }

  async function broadcastTransaction(tx_hex: string) {
    const electrum = await electrumConnect();
    try {
      const tx_hash = await electrum.request(
        'blockchain.transaction.broadcast',
        tx_hex
      );
      return tx_hash;
    } finally {
      // Keep the connection open for subsequent requests
    }
  }

  return {
    electrumConnect,
    electrumDisconnect,
    getBalance,
    getUTXOS,
    broadcastTransaction,
  };
}
