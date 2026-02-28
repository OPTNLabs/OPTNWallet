import { Network } from '../../../redux/networkSlice';
import { toBigIntAmount } from '../utils';

type ContractArg = {
  name: string;
  type: string;
};

type ContractManagerLike = {
  createContract: (
    artifactName: string,
    constructorArgs: unknown[],
    currentNetwork: Network
  ) => Promise<unknown>;
  fetchContractInstances: () => Promise<
    Array<{
      id: number;
      address: string;
      utxos: Array<{ amount: number | string | bigint }>;
      [key: string]: unknown;
    }>
  >;
  deleteContractInstance: (contractId: number) => Promise<void>;
  updateContractUTXOs: (address: string) => Promise<{ added: number; removed: number }>;
  getContractInstanceByAddress: (address: string) => Promise<{
    address: string;
    utxos: Array<{ amount: number | string | bigint }>;
    [key: string]: unknown;
  } | null>;
};

export async function createContractAndFetchInstances(params: {
  contractManager: ContractManagerLike;
  selectedContractFile: string;
  args: unknown[];
  constructorArgs: ContractArg[];
  currentNetwork: Network;
}) {
  const {
    contractManager,
    selectedContractFile,
    args,
    constructorArgs,
    currentNetwork,
  } = params;

  if (constructorArgs.length > 0 && args.length !== constructorArgs.length) {
    throw new Error('All constructor arguments must be provided');
  }

  await contractManager.createContract(selectedContractFile, args, currentNetwork);
  return await contractManager.fetchContractInstances();
}

export async function deleteContractAndFetchInstances(params: {
  contractManager: ContractManagerLike;
  contractId: number;
}) {
  const { contractManager, contractId } = params;
  await contractManager.deleteContractInstance(contractId);
  return await contractManager.fetchContractInstances();
}

export async function updateContractAndRebuildInstance(params: {
  contractManager: ContractManagerLike;
  address: string;
}) {
  const { contractManager, address } = params;
  await contractManager.updateContractUTXOs(address);
  const updatedContractInstance =
    await contractManager.getContractInstanceByAddress(address);
  if (!updatedContractInstance) {
    throw new Error('Updated contract instance not found');
  }

  const totalBalance = updatedContractInstance.utxos.reduce(
    (sum: bigint, utxo: { amount: number | string | bigint }) =>
      sum + toBigIntAmount(utxo.amount),
    BigInt(0)
  );

  return {
    updatedContractInstance,
    totalBalance,
  };
}
