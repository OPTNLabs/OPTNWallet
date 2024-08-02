// @ts-ignore
import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  Network,
  SignatureTemplate,
  HashType,
  Contract,
} from 'cashscript';
import ContractManager from '../ContractManager/ContractManager';
import KeyManager from '../WalletManager/KeyManager';
import { bigIntToString, stringToBigInt } from '../../utils/bigIntConversion';
import parseInputValue from '../../utils/parseInputValue';

export interface UTXO {
  tx_hash: string;
  tx_pos: number;
  amount: number | bigint;
  address: string;
  privateKey?: Uint8Array;
  token_data?: {
    amount: string;
    category: string;
  };
}

export interface TransactionOutput {
  recipientAddress: string;
  amount: number | bigint;
  token?: {
    amount: number | bigint;
    category: string;
  };
}

export default function TransactionBuilderHelper() {
  const provider = new ElectrumNetworkProvider(Network.CHIPNET);
  const contractManager = ContractManager();
  const keyManager = KeyManager();

  async function buildTransaction(
    utxos: UTXO[],
    outputs: TransactionOutput[],
    contractFunction: string | null = null,
    contractFunctionInputs: any[] | null = null
  ) {
    const txBuilder = new TransactionBuilder({ provider });

    console.log('Building transaction with UTXOs:', utxos);
    console.log('Outputs:', outputs);
    console.log('Contract Function:', contractFunction);
    console.log('Contract Function Inputs:', contractFunctionInputs);

    const unlockableUtxos = await Promise.all(
      utxos.map(async (utxo) => {
        console.log('Processing UTXO:', utxo);

        let unlocker: any;

        if (!utxo.contractName || !utxo.abi) {
          // Non-contract UTXOs (e.g., P2PKH)
          let privateKey = utxo.privateKey;
          console.log('Using private key from UTXO:', privateKey);

          // If privateKey from UTXO is not available, fetch from database
          if (!privateKey) {
            console.log(
              'Private key not found in UTXO, fetching from database'
            );
            privateKey = keyManager.fetchAddressPrivateKey(utxo.address);
            console.log(
              'Fetched private key for address:',
              utxo.address,
              'Result:',
              privateKey
            );
          }

          if (!privateKey || privateKey.length === 0) {
            console.error(
              `Private key not found or empty for address: ${utxo.address}`
            );
            throw new Error(
              `Private key not found or empty for address: ${utxo.address}`
            );
          }

          console.log('Private key found:', privateKey);

          // Additional check to ensure it's a Uint8Array
          if (!(privateKey instanceof Uint8Array)) {
            console.error(
              'Fetched private key is not a Uint8Array:',
              privateKey
            );
            throw new Error('Fetched private key is not a Uint8Array');
          }

          const signatureTemplate = new SignatureTemplate(
            privateKey,
            HashType.SIGHASH_ALL
          );
          unlocker = signatureTemplate.unlockP2PKH();

          console.log('Using unlockP2PKH for non-contract UTXO');
        } else {
          // Contract UTXOs
          console.log('Fetching contract unlock function for UTXO');
          const contractUnlockFunction = await getContractUnlockFunction(
            utxo,
            contractFunction,
            contractFunctionInputs
          );

          unlocker = contractUnlockFunction.unlocker;

          console.log('Using Contract Unlocker for contract UTXO');
        }

        return {
          txid: utxo.tx_hash,
          vout: utxo.tx_pos,
          satoshis: BigInt(utxo.amount),
          unlocker,
          token_data: utxo.token_data,
        };
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
    console.log('tx builder:', txBuilder);

    try {
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
    console.log(
      'Fetched contract instance constructor inputs:',
      contractInstance.artifact.constructorInputs
    );
    console.log('Fetched contract function inputs:', contractFunctionInputs);

    if (!contractInstance) {
      throw new Error(
        `Contract instance not found for address ${utxo.address}`
      );
    }

    // Reference constructorInputs directly from the contract artifact
    const constructorInputs = await contractManager.fetchConstructorArgs(
      utxo.address
    );

    console.log('Constructor Inputs', constructorInputs);

    const constructorArgs = contractInstance.artifact.constructorInputs.map(
      (input, index) => parseInputValue(constructorInputs[index], input.type)
    );

    console.log('Constructor Args: ', constructorArgs);

    const contract = new Contract(contractInstance.artifact, constructorArgs, {
      provider,
      addressType: 'p2sh32',
    });

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
