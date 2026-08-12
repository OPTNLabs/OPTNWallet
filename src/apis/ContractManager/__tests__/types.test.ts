import { describe, expectTypeOf, it } from 'vitest';

import type {
  AbiFunction,
  ContractArtifact,
  ContractInstanceRow,
  ContractManagerApi,
  StoredContractUtxo,
} from '../types';

describe('ContractManager/types', () => {
  it('defines expected shape contracts for artifact and instances', () => {
    expectTypeOf<AbiFunction>().toMatchTypeOf<{ name?: string; inputs?: Array<{ name: string; type: string }> }>();

    expectTypeOf<ContractArtifact>().toMatchTypeOf<{
      contractName: string;
      constructorInputs: Array<{ name: string; type: string }>;
      abi: AbiFunction[];
      bytecode?: string;
    }>();

    expectTypeOf<StoredContractUtxo>().toMatchTypeOf<{
      tx_hash: string;
      tx_pos: number;
      amount: bigint;
      height: number;
      prefix: string;
    }>();

    expectTypeOf<ContractInstanceRow>().toMatchTypeOf<{
      id: number;
      contract_name: string;
      address: string;
      token_address: string;
      abi: AbiFunction[];
      artifact: ContractArtifact;
    }>();
  });

  it('exposes API methods on ContractManagerApi', () => {
    expectTypeOf<ContractManagerApi>().toMatchTypeOf<{
      createContract: (...args: unknown[]) => Promise<unknown>;
      saveContractArtifact: (...args: unknown[]) => Promise<void>;
      getContractArtifact: (...args: unknown[]) => Promise<ContractArtifact | null>;
      listAvailableArtifacts: (...args: unknown[]) => Promise<unknown[]>;
      deleteContractInstance: (...args: unknown[]) => Promise<void>;
      fetchContractInstances: (...args: unknown[]) => Promise<ContractInstanceRow[]>;
      getContractInstanceByAddress: (...args: unknown[]) => Promise<ContractInstanceRow | null>;
      loadArtifact: (...args: unknown[]) => Promise<ContractArtifact | null>;
      fetchConstructorArgs: (...args: unknown[]) => Promise<unknown[] | null>;
      updateContractUTXOs: (...args: unknown[]) => Promise<{ added: number; removed: number }>;
      getContractUnlockFunction: (...args: unknown[]) => Promise<{ lockingBytecode: unknown; unlocker: unknown }>;
    }>();
  });
});
