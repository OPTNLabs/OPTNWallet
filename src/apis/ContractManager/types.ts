type AbiInput = { name: string; type: string };
type AbiFunction = { name?: string; inputs?: AbiInput[] };

export type AvailableContractEntry = {
  fileName: string;
  contractName: string;
  source: 'builtin' | 'addon';
};

export type SqlRow = Record<string, unknown>;

export type ContractArtifact = {
  contractName: string;
  constructorInputs: AbiInput[];
  abi: AbiFunction[];
  bytecode?: string;
  source?: string;
  compiler?: { name?: string; version?: string };
  updatedAt?: string;
  [key: string]: unknown;
};

export type StoredContractRow = {
  tx_hash: string;
  tx_pos: number;
};

export type StoredContractUtxo = {
  tx_hash: string;
  tx_pos: number;
  amount: bigint;
  height: number;
  token?: unknown;
  prefix: string;
  contractFunction?: string | null;
  contractFunctionInputs?: string | null;
};

export type ContractInstanceUtxo = {
  tx_hash: string;
  tx_pos: number;
  amount: bigint;
  height: number;
  token?: unknown;
  prefix?: string;
  contractFunction?: string;
  contractFunctionInputs?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ContractInstanceRow = {
  id: number;
  contract_name: string;
  address: string;
  token_address: string;
  abi: AbiFunction[];
  artifact: ContractArtifact;
  utxos: ContractInstanceUtxo[];
  unlock: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type ContractManagerApi = {
  createContract: (
    artifactName: string,
    constructorArgs: unknown[],
    currentNetwork: import('../../redux/networkSlice').Network
  ) => Promise<unknown>;
  saveContractArtifact: (artifact: ContractArtifact) => Promise<void>;
  getContractArtifact: (contractName: string) => Promise<ContractArtifact | null>;
  listAvailableArtifacts: () => Promise<AvailableContractEntry[]>;
  deleteContractInstance: (contractId: number) => Promise<void>;
  fetchContractInstances: () => Promise<ContractInstanceRow[]>;
  getContractInstanceByAddress: (
    address: string
  ) => Promise<ContractInstanceRow | null>;
  loadArtifact: (artifactName: string) => Promise<ContractArtifact | null>;
  fetchConstructorArgs: (address: string) => Promise<unknown[] | null>;
  updateContractUTXOs: (
    address: string
  ) => Promise<{ added: number; removed: number }>;
  getContractUnlockFunction: (
    utxo: import('../../types/types').UTXO,
    contractFunction: string,
    contractFunctionInputs: Record<string, unknown>
  ) => Promise<{ lockingBytecode: unknown; unlocker: unknown }>;
};

export type { AbiInput, AbiFunction };
