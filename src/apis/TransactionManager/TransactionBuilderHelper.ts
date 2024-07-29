import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  Network,
  SignatureTemplate,
  Contract,
} from 'cashscript';
import ContractManager from '../ContractManager/ContractManager';
import { bigIntToString, stringToBigInt } from '../utils/bigIntConversion';
import { scriptToBytecode } from '@cashscript/utils';

export interface UTXO {
  tx_hash: string;
  tx_pos: number;
  amount: number;
  address: string;
  privateKey?: Uint8Array;
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

export default function TransactionBuilderHelper() {
  const provider = new ElectrumNetworkProvider(Network.CHIPNET);
  const contractManager = ContractManager();

  async function buildTransaction(
    utxos: UTXO[],
    outputs: TransactionOutput[],
    contractFunction: string | null,
    contractFunctionInputs: any[] | null
  ) {
    const txBuilder = new TransactionBuilder({ provider });

    console.log('Building transaction with UTXOs:', utxos);
    console.log('Outputs:', outputs);
    console.log('Contract Function:', contractFunction);
    console.log('Contract Function Inputs:', contractFunctionInputs);

    const unlockableUtxos = await Promise.all(
      utxos.map(async (utxo) => {
        if (utxo.privateKey) {
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
          if (!contractFunction || !contractFunctionInputs) {
            throw new Error(
              'Contract function and inputs are required for contract UTXOs'
            );
          }
          const contractUnlockFunction = await getContractUnlockFunction(
            utxo,
            contractFunction,
            contractFunctionInputs
          );
          return {
            txid: utxo.tx_hash,
            vout: utxo.tx_pos,
            satoshis: BigInt(utxo.amount),
            scriptPubKey: scriptToBytecode(
              contractUnlockFunction.lockingBytecode
            ),
            unlocker: contractUnlockFunction.unlocker,
            token_data: utxo.token_data,
          };
        }
      })
    );

    console.log('Unlockable UTXOs:', unlockableUtxos);

    txBuilder.addInputs(unlockableUtxos);

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

    console.log('Transaction Outputs:', txOutputs);

    txBuilder.addOutputs(txOutputs);

    try {
      console.log('tx builder:', txBuilder);
      const builtTransaction = txBuilder.build();
      console.log('Built Transaction:', builtTransaction);
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
    console.log('Fetching contract instance for address:', utxo.address);
    const contractInstance = await contractManager.getContractInstanceByAddress(
      utxo.address
    );
    console.log('Fetched contract instance:', contractInstance);

    if (!contractInstance) {
      throw new Error(
        `Contract instance not found for address ${utxo.address}`
      );
    }

    const contract = new Contract(
      contractInstance.artifact,
      contractFunctionInputs.map((input) => input.value),
      {
        provider,
        addressType: 'p2sh32',
      }
    );

    const abiFunction = contractInstance.abi.find(
      (func) => func.name === contractFunction
    );
    console.log('ABI function found:', abiFunction);

    if (!abiFunction) {
      throw new Error(
        `ABI function '${contractFunction}' not found in contract ${contract.contractName}`
      );
    }

    const unlocker = contract.unlock[contractFunction](
      ...contractFunctionInputs.map((input) =>
        input.type === 'sig' ? new SignatureTemplate(input.value) : input.value
      )
    );

    console.log('Contract Unlock Function:', {
      lockingBytecode: contract.redeemScript,
      unlocker,
    });

    return {
      lockingBytecode: contract.redeemScript,
      unlocker,
    };
  }

  const sendTransaction = async (tx: string) => {
    try {
      const txid = await provider.sendRawTransaction(tx);
      console.log('Sent Transaction:', txid);
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
