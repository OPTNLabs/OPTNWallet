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
import { selectCurrentNetwork } from '../../redux/selectors/networkSelectors';
import { Network } from '../../redux/networkSlice';

const testServer = chipnetServers[0];
const mainServer = mainnetServers[0];

function getCurrentServer(): string {
  const state = store.getState();
  const currentNetwork = selectCurrentNetwork(state);

  return currentNetwork === Network.MAINNET ? mainServer : testServer;
}

export default function ElectrumServer() {
  let electrum: ElectrumClient | null = null;

  async function electrumConnect(
    server: string = getCurrentServer()
  ): Promise<ElectrumClient> {
    if (electrum) {
      console.log('Reusing existing Electrum connection');
      electrum.connection.reconnect;
    } else {
      electrum = new ElectrumClient(
        'OPTNWallet',
        '1.5.3',
        server,
        ElectrumTransport.WSS.Port,
        ElectrumTransport.WSS.Scheme
      );

      await electrum.connect();
    }

    // console.log('Connected to Electrum server:', server);
    return electrum;
  }

  async function electrumDisconnect(): Promise<boolean> {
    if (electrum) {
      await electrum.disconnect(true);
      // console.log('Disconnected from Electrum server');
      electrum = null;
      return true;
    }
    return false;
  }

  async function request(
    method: string,
    ...params: any[]
  ): Promise<RequestResponse> {
    const electrum = await electrumConnect();
    const response = await await electrum.request(method, ...params);
    await electrumDisconnect();
    return response;
  }

  return {
    electrumConnect,
    electrumDisconnect,
    request,
  };
}
