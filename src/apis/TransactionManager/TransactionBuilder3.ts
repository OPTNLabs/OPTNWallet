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
  token_data?: {
    amount: string;
    category: string;
  };
}

export interface TransactionOutput {
  recipientAddress: string;
  amount: number;
  token?: {
    amount: number;
    category: string;
  };
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
        token_data: utxo.token_data,
      };
    });

    // Adding inputs
    txBuilder.addInputs(unlockableUtxos);

    // Prepare transaction outputs
    const txOutputs = outputs.map((output) => {
      const baseOutput = {
        to: output.recipientAddress,
        amount: BigInt(output.amount),
      };

      if (output.token) {
        return {
          ...baseOutput,
          token: {
            amount: BigInt(output.token.amount),
            category: output.token.category,
          },
        };
      }

      return baseOutput;
    });

    // Adding outputs
    txBuilder.addOutputs(txOutputs);

    try {
      console.log('tx builder:', txBuilder);
      const builtTransaction = txBuilder.build();
      return builtTransaction;
    } catch (error) {
      console.error('Error building transaction:', error);
      return null;
    }
  }

  const sendTransaction = async (tx: string) => {
    try {
      const txid = provider.sendRawTransaction(tx);
      return txid;
    } catch (error) {
      console.log(error);
      return null;
    }
  };

  return {
    buildTransaction,
    sendTransaction,
  };
}
