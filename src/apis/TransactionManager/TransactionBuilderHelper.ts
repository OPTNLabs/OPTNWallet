import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
  HashType,
  Contract,
} from 'cashscript';
import ContractManager from '../ContractManager/ContractManager';
import parseInputValue from '../../utils/parseInputValue';
import { UTXO, TransactionOutput } from '../../types/types'; // Updated import to include UTXO and TransactionOutput interfaces
import { store } from '../../redux/store';
import KeyService from '../../services/KeyService';

export default function TransactionBuilderHelper() {
  const currentNetwork = store.getState().network.currentNetwork;

  const provider = new ElectrumNetworkProvider(currentNetwork);
  const contractManager = ContractManager();

  // Add a new function to build transaction outputs
  function prepareTransactionOutputs(outputs: TransactionOutput[]): any[] {
    return outputs.map((output) => {
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
  }

  async function buildTransaction(
    utxos: UTXO[],
    outputs: TransactionOutput[],
    contractFunction: string | null = null,
    contractFunctionInputs: any[] | null = null
  ) {
    const txBuilder = new TransactionBuilder({ provider });

    const unlockableUtxos = await Promise.all(
      utxos.map(async (utxo) => {
        let unlocker: any;

        const processedUtxo = {
          ...utxo,
          value: utxo.value || utxo.amount,
        };

        if (!processedUtxo.contractName || !processedUtxo.abi) {
          const privateKey = await KeyService.fetchAddressPrivateKey(
            processedUtxo.address
          );

          if (!privateKey || privateKey.length === 0) {
            throw new Error(
              `Private key not found or empty for address: ${processedUtxo.address}`
            );
          }

          const signatureTemplate = new SignatureTemplate(
            privateKey,
            HashType.SIGHASH_ALL
          );
          unlocker = signatureTemplate.unlockP2PKH();
        } else {
          const contractUnlockFunction = await getContractUnlockFunction(
            processedUtxo,
            contractFunction,
            contractFunctionInputs
          );
          unlocker = contractUnlockFunction.unlocker;
        }

        return {
          txid: processedUtxo.tx_hash,
          vout: processedUtxo.tx_pos,
          satoshis: BigInt(processedUtxo.value),
          unlocker,
          token_data: processedUtxo.token_data,
        };
      })
    );

    txBuilder.addInputs(unlockableUtxos);

    const txOutputs = prepareTransactionOutputs(outputs);
    txBuilder.addOutputs(txOutputs);

    try {
      const builtTransaction = txBuilder.build();
      return builtTransaction;
    } catch (error) {
      console.error('Error building transaction:', error);
      return null;
    }
  }

  // Ensure proper handling of `SignatureTemplate` for `sig` types
  async function getContractUnlockFunction(
    utxo: UTXO,
    contractFunction: string,
    contractFunctionInputs: any[]
  ) {
    // Log the contract function inputs before processing
    console.log('Contract function inputs:', contractFunctionInputs);

    console.log('Fetching contract instance for UTXO address:', utxo.address);

    // Fetch the contract instance for the UTXO's address
    const contractInstance = await contractManager.getContractInstanceByAddress(
      utxo.address
    );

    if (!contractInstance) {
      throw new Error(
        `Contract instance not found for address ${utxo.address}`
      );
    }

    console.log('Contract instance fetched:', contractInstance);
    console.log('Contract artifact:', contractInstance.artifact);

    // Fetch constructor inputs for the contract
    const constructorInputs = await contractManager.fetchConstructorArgs(
      utxo.address
    );
    console.log('Fetched constructor inputs:', constructorInputs);

    // Parse constructor arguments using the contract's artifact
    const constructorArgs = contractInstance.artifact.constructorInputs.map(
      (input, index) => parseInputValue(constructorInputs[index], input.type)
    );

    console.log('Parsed constructor arguments:', constructorArgs);

    // Create a new contract instance
    const contract = new Contract(contractInstance.artifact, constructorArgs, {
      provider,
      addressType: 'p2sh32',
    });

    console.log(
      'Created contract instance with parsed constructor arguments:',
      contract
    );

    // Find the ABI function in the contract using the provided function name
    const abiFunction = contractInstance.abi.find(
      (func) => func.name === contractFunction
    );

    console.log(
      'ABI function for contractFunction:',
      contractFunction,
      '\nABI Function:',
      abiFunction,
      '\nContract Function Inputs',
      contractFunctionInputs
    );

    if (!abiFunction) {
      throw new Error(
        `ABI function '${contractFunction}' not found in contract`
      );
    }

    // Ensure that the contract function inputs are mapped correctly
    const unlocker = contract.unlock[contractFunction](
      ...abiFunction.inputs.map((input) => {
        // Get the corresponding value from contractFunctionInputs using the input name
        const inputValue = contractFunctionInputs[input.name];

        // Check if the input name is 's' (for signature)
        if (input.type === 'sig') {
          // Handle signature input with `SignatureTemplate`
          return new SignatureTemplate(inputValue, HashType.SIGHASH_ALL);
        } else {
          // For other inputs, return the value directly
          return inputValue;
        }
      })
    );

    console.log('Generated unlocker for contract function:', unlocker);

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
