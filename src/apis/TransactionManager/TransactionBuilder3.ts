import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  Network,
  SignatureTemplate,
} from 'cashscript';
import ContractManager from '../ContractManager/ContractManager';

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
  const contractManager = ContractManager();

  async function buildTransaction(
    utxos: UTXO[],
    outputs: TransactionOutput[],
    contractFunction: string,
    contractFunctionInputs: any[]
  ) {
    const txBuilder = new TransactionBuilder({ provider });

    // Prepare UTXOs with unlockers
    const unlockableUtxos = await Promise.all(
      utxos.map(async (utxo) => {
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
          const contractUnlockFunction = await getContractUnlockFunction(
            utxo,
            contractFunction,
            contractFunctionInputs
          );
          return {
            txid: utxo.tx_hash,
            vout: utxo.tx_pos,
            satoshis: BigInt(utxo.amount),
            scriptPubKey: contractUnlockFunction.lockingBytecode,
            unlocker: contractUnlockFunction.unlocker,
            token_data: utxo.token_data,
          };
        }
      })
    );

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

  async function getContractUnlockFunction(
    utxo,
    contractFunction,
    contractFunctionInputs
  ) {
    const contractInstance = await contractManager.getContractInstanceByAddress(
      utxo.address
    );
    if (!contractInstance) {
      throw new Error(
        `Contract instance not found for address ${utxo.address}`
      );
    }

    const contract = contractInstance;
    const abiFunction = contract.abi.find(
      (func) => func.name === contractFunction
    );
    if (!abiFunction) {
      throw new Error(
        `ABI function '${contractFunction}' not found in contract ${contract.contractName}`
      );
    }

    const unlocker = contract.unlock[contractFunction](
      ...contractFunctionInputs
    );

    return {
      lockingBytecode: contract.redeemScript,
      unlocker,
    };
  }

  const sendTransaction = async (tx: string) => {
    try {
      const txid = await provider.sendRawTransaction(tx);
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
