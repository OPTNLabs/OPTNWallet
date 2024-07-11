// @ts-nocheck
import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  Network,
  SignatureTemplate,
} from 'cashscript';

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

    // Prepare UTXOs with unlockers
    const unlockableUtxos = utxos.map((utxo) => {
      if (!utxo.privateKey || utxo.privateKey.length === 0) {
        throw new Error(
          `Invalid private key for UTXO at ${utxo.tx_hash}:${utxo.tx_pos}`
        );
      }

      console.log('private key', utxo.privateKey);
      const signatureTemplate = new SignatureTemplate(utxo.privateKey);
      console.log('Sig Template', signatureTemplate);
      return {
        ...utxo,
        unlocker: signatureTemplate.unlockP2PKH(),
      };
    });

    // Adding inputs
    txBuilder.addInputs(unlockableUtxos);

    // Prepare transaction outputs
    const txOutputs = outputs.map((output) => ({
      to: output.recipientAddress,
      amount: BigInt(output.amount),
    }));

    // Adding outputs
    txBuilder.addOutputs(txOutputs);

    console.log('tx builder:', txBuilder);

    const builtTransaction = txBuilder.build();
    console.log('Built Transaction:', builtTransaction);
    return builtTransaction;
  }

  return {
    buildTransaction,
  };
}
