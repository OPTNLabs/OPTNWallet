// @ts-nocheck
import { ElectrumNetworkProvider, TransactionBuilder, Network, SignatureTemplate } from 'cashscript';
import { UTXOs } from '../types';
import { Utxo } from 'cashscript';
import UTXOManager from '../UTXOManager/UTXOManager';
import { Decimal } from 'decimal.js';
const DUST_LIMIT = 546;

export default function TransactionBuilders() {
    const provider = new ElectrumNetworkProvider(Network.CHIPNET);
    const ManageUTXOs = UTXOManager();
    
    async function createTransaction(
        wallet_name: string,
        recipients: Array<{ address: string; amount: number }>,
        fee: number = DUST_LIMIT / 3,
    ): Promise<any> {
        const sendTotal = recipients
            .reduce((sum, cur) => sum.plus(cur.amount), new Decimal(0))
            .toNumber();
        const UTXO_inputs: UTXOs[] | null = await (await ManageUTXOs).fetchUTXOs(sendTotal, fee, "BCH", wallet_name);
        if (UTXO_inputs == null) {
            console.log('no utxo inputs fetched from wallet');
            return null;
        }

        const convertedUTXOs: Utxo[] = UTXO_inputs.map(utxo => ({
            txid: utxo.tx_hash,
            vout: utxo.tx_pos,
            satoshis: BigInt(utxo.amount),
        }));

        const privateKeys: Uint8Array[] = UTXO_inputs.map(utxo => utxo.private_key);
        const transactionBuilder = new TransactionBuilder({ provider });

        convertedUTXOs.forEach((utxo, index) => {
            const newTemplate = new SignatureTemplate(privateKeys[index]);
            transactionBuilder.addInput(utxo, newTemplate.unlockP2PKH());
        });

        recipients.forEach(recipient => {
            console.log(recipient.address);
            transactionBuilder.addOutput({ to: recipient.address, amount: BigInt(recipient.amount) });
        });

        transactionBuilder.setMaxFee(BigInt(10000000));

        const txDetails = await transactionBuilder.send();
        console.log('Transaction details:', txDetails);

        const txHex = transactionBuilder.build();
        console.log('Transaction hex:', txHex);

        return txDetails;
    }

    return {
        createTransaction
    };
}
