import { ElectrumNetworkProvider, TransactionBuilder, Network, SignatureTemplate } from 'cashscript';

export interface UTXO {
    tx_hash: string;
    tx_pos: number;
    amount: number;
    address: string;
    privateKey: Uint8Array; // Assuming you have the private key for signing
}

export interface TransactionOutput {
    recipientAddress: string;
    amount: number;
}

export default function TransactionBuilder3() {
    const provider = new ElectrumNetworkProvider(Network.CHIPNET);

    async function buildTransaction(utxos: UTXO[], outputs: TransactionOutput[]) {
        const txBuilder = new TransactionBuilder({ provider });

        // Adding inputs with unlockers
        utxos.forEach(utxo => {
            const signatureTemplate = new SignatureTemplate(utxo.privateKey);
            const unlockableUtxo = {
                ...utxo,
                unlocker: signatureTemplate.unlockP2PKH()
            };
            txBuilder.addInput(unlockableUtxo);
        });

        // Adding outputs
        outputs.forEach(output => {
            txBuilder.addOutput(output.recipientAddress, BigInt(output.amount));
        });

        const builtTransaction = txBuilder.build();
        console.log('Built Transaction:', builtTransaction);
        return builtTransaction;
    }

    return {
        buildTransaction
    };
}
