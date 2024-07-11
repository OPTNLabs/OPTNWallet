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

      const signatureTemplate = new SignatureTemplate(utxo.privateKey);
      return {
        txid: utxo.tx_hash,
        vout: utxo.tx_pos,
        satoshis: BigInt(utxo.amount),
        scriptPubKey: signatureTemplate.lockingBytecode,
        unlocker: signatureTemplate.unlockP2PKH(),
      };
    });

    // Adding inputs
    txBuilder.addInputs(unlockableUtxos);

    console.log('TX Builder - Inputs:', txBuilder.inputs);

    // Prepare transaction outputs
    const txOutputs = outputs.map((output) => ({
      to: output.recipientAddress,
      amount: BigInt(output.amount),
    }));

    // Adding outputs
    txBuilder.addOutputs(txOutputs);

    console.log('TX Builder - Outputs:', txBuilder.outputs);

    try {
      const builtTransaction = txBuilder.build();
      console.log('Built Transaction:', builtTransaction);
      return builtTransaction;
    } catch (error) {
      console.error('Error building transaction:', error);
      return null;
    }
  }

  return {
    buildTransaction,
  };
}
