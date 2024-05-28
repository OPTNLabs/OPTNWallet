import { ElectrumClient, ElectrumTransport } from 'electrum-cash';
import { chipnetServers } from '../../utils/servers/ElectrumServers';
import { BalanceResponse } from '../interfaces';

export enum Network {
    CHIPNET
}
//this is to declare the type of the electrum
let electrum: ElectrumClient | null = null;

const testServer = chipnetServers[0];



export default function ElectrumService() {
    async function electrumConnect (server : string = testServer): Promise<void>{
        electrum = new ElectrumClient('OPTNWallet', '1.4.1', server, ElectrumTransport.WSS.Port, ElectrumTransport.WSS.Scheme);
        return electrum.connect();
    }

    async function electrumInstance (server: string = testServer) : Promise<ElectrumClient> {
        electrum = new ElectrumClient('OPTNWallet', '1.4.1', server, ElectrumTransport.WSS.Port, ElectrumTransport.WSS.Scheme);
        return electrum
    }

    async function electrumDisconnect(status: boolean) : Promise<boolean> {
        if (electrum !== null) {
            return electrum.disconnect(status);
        }
        return true;
    };

    async function getBalance(address: string): Promise<number> {
        if (electrum !== null) {
            const params = [address, "include_tokens"];
            const response: any = await electrum.request("blockchain.address.get_balance", ...params);

            if (response && typeof response.confirmed === 'number' && typeof response.unconfirmed === 'number') {
                const { confirmed, unconfirmed } = response as BalanceResponse;
                return confirmed + unconfirmed;
            } else {
                throw new Error("Unexpected response format");
            }
        } else {
            throw new Error("Electrum client is not initialized");
        }
    }

    async function getUTXOS(address : string) : Promise<any> {
        console.log("getting utxos")
        if (electrum !== null) {
            const UTXOs = await electrum.request(
                "blockchain.address.listunspent",
                address
            );
            console.log(UTXOs)
            return UTXOs;
        }
    }

    async function broadcastTransaction(tx_hex : string) {
        if (electrum !== null) {
            const tx_hash = await electrum.request(
                "blockchain.transaction.broadcast",
                tx_hex
            );
            console.log('hallo')
            return tx_hash;
        }
    }
    return { electrumConnect, electrumDisconnect, getBalance, getUTXOS, broadcastTransaction, electrumInstance }

}
