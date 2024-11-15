// @ts-nocheck

// src/services/ContractService.ts
import ContractManager from '../apis/ContractManager/ContractManager';
import { UTXO } from '../types/types';
import { Contract, SignatureTemplate, HashType } from 'cashscript';
import parseInputValue from '../utils/parseInputValue';

export default function ContractService() {
  const contractManager = ContractManager();

  async function getContractUnlockFunction(
    utxo: UTXO,
    contractFunction: string,
    contractFunctionInputs: any[]
  ) {
    const contractInstance = await contractManager.getContractInstanceByAddress(
      utxo.address
    );

    if (!contractInstance) {
      throw new Error(
        `Contract instance not found for address ${utxo.address}`
      );
    }

    const constructorInputs = await contractManager.fetchConstructorArgs(
      utxo.address
    );
    const constructorArgs = contractInstance.artifact.constructorInputs.map(
      (input, index) => parseInputValue(constructorInputs[index], input.type)
    );

    const contract = new Contract(contractInstance.artifact, constructorArgs, {
      provider: contractManager.provider,
      addressType: 'p2sh32',
    });

    const abiFunction = contractInstance.abi.find(
      (func) => func.name === contractFunction
    );
    if (!abiFunction) {
      throw new Error(
        `ABI function '${contractFunction}' not found in contract`
      );
    }

    const unlocker = contract.unlock[contractFunction](
      ...abiFunction.inputs.map((input) =>
        input.type === 'sig'
          ? new SignatureTemplate(contractFunctionInputs[input.name])
          : contractFunctionInputs[input.name]
      )
    );

    return {
      lockingBytecode: contract.redeemScript,
      unlocker,
    };
  }

  return {
    getContractUnlockFunction,
  };
}
