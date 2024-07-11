import { ElectrumClient, ElectrumTransport } from 'electrum-cash';
import { chipnetServers } from '../../utils/servers/ElectrumServers';
import { BalanceResponse } from '../interfaces';

export enum Network {
  CHIPNET,
}

const testServer = chipnetServers[0];

export default function ElectrumService() {
  async function electrumConnect(
    server: string = testServer
  ): Promise<ElectrumClient> {
    const electrum = new ElectrumClient(
      'OPTNWallet',
      '1.5.3',
      server,
      ElectrumTransport.WSS.Port,
      ElectrumTransport.WSS.Scheme
    );
    await electrum.connect();
    return electrum;
  }

  async function electrumDisconnect(
    electrum: ElectrumClient
  ): Promise<boolean> {
    return electrum.disconnect(true);
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
      await electrumDisconnect(electrum);
    }
  }

  async function getUTXOS(address: string): Promise<any> {
    const electrum = await electrumConnect();
    try {
      const UTXOs = await electrum.request(
        'blockchain.address.listunspent',
        address
      );
      console.log(`${address} UTXOS: `, UTXOs);
      if (UTXOs) {
        return UTXOs;
      }
      return [];
    } finally {
      await electrumDisconnect(electrum);
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
      await electrumDisconnect(electrum);
    }
  }

  return { electrumConnect, getBalance, getUTXOS, broadcastTransaction };
}
