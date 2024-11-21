import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
  HashType,
  // Contract,
} from 'cashscript';
import ContractManager from '../ContractManager/ContractManager';
// import parseInputValue from '../../utils/parseInputValue';
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
          if (!contractFunction || !contractFunctionInputs) {
            throw new Error('Contract function and inputs must be provided');
          }

          const contractUnlockFunction =
            await contractManager.getContractUnlockFunction(
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
