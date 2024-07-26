// @ts-expect-error

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
  privateKey?: Uint8Array; // Optional for contract UTXOs
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
      if (utxo.privateKey) {
        // Regular UTXO
        const signatureTemplate = new SignatureTemplate(utxo.privateKey);
        return {
          txid: utxo.tx_hash,
          vout: utxo.tx_pos,
          satoshis: BigInt(utxo.amount),
          scriptPubKey: signatureTemplate.lockingBytecode,
          unlocker: signatureTemplate.unlockP2PKH(),
          token_data: utxo.token_data,
        };
      } else {
        // Contract UTXO
        const contractUnlockFunction = getContractUnlockFunction(utxo);
        return {
          txid: utxo.tx_hash,
          vout: utxo.tx_pos,
          satoshis: BigInt(utxo.amount),
          scriptPubKey: contractUnlockFunction.lockingBytecode,
          unlocker: contractUnlockFunction.unlocker,
          token_data: utxo.token_data,
        };
      }
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

  function getContractUnlockFunction(utxo) {
    const { contractName, abi, args } = utxo;
    const contract = new ContractManager().loadArtifact(contractName);

    // Find the matching function in the ABI
    const abiFunction = abi.find((func) => func.name === 'spend');
    if (!abiFunction) {
      throw new Error(
        `ABI function 'spend' not found in contract ${contractName}`
      );
    }

    // Construct the unlocker
    const unlocker = contract.functions.spend(...args);

    return {
      lockingBytecode: contract.lockingBytecode,
      unlocker,
    };
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
