// src/apis/ContractManager/ContractManager.tsx

import {
  Contract,
  ElectrumNetworkProvider,
  SignatureTemplate,
  HashType,
} from 'cashscript';
import DatabaseService from '../DatabaseManager/DatabaseService';
import parseInputValue from '../../utils/parseInputValue';
import { Network } from '../../redux/networkSlice';
import { store } from '../../redux/store';
import ElectrumService from '../../services/ElectrumService';
import KeyService from '../../services/KeyService';
import { UTXO } from '../../types/types';
import AddonsRegistry from '../../services/AddonsRegistry';
import {
  findAddonContract,
  normalizeAddonKey,
  outpointKey,
  parseJsonOr,
  serializeUnlockFunctions,
  toStoredContractUtxo,
} from './helpers';
import { createBuiltinArtifactCache } from './artifacts';
import { parseContractInstanceRow } from './parsers';
import type {
  AbiFunction,
  AbiInput,
  AvailableContractEntry,
  ContractArtifact,
  ContractInstanceRow,
  ContractManagerApi,
  SqlRow,
  StoredContractRow,
  StoredContractUtxo,
} from './types';
type ContractCtorArtifact = ConstructorParameters<typeof Contract>[0];

export type {
  AvailableContractEntry,
  ContractArtifact,
  ContractInstanceRow,
  StoredContractUtxo,
} from './types';

export default function ContractManager(): ContractManagerApi {
  const dbService = DatabaseService();

  // ---- Addons (no React hooks here; ContractManager is not a component) ----
  const addons = AddonsRegistry();

  // Kick off init once per service instance; safe even if BUILTIN_ADDONS is empty.
  const addonsInit = addons.init().catch((e) => {
    console.warn('[addons] init failed:', e);
  });

  // Cache artifacts in memory to avoid redundant loading
  const artifactCache = createBuiltinArtifactCache();

  return {
    createContract,
    saveContractArtifact,
    getContractArtifact,
    listAvailableArtifacts,
    deleteContractInstance,
    fetchContractInstances,
    getContractInstanceByAddress,
    loadArtifact,
    fetchConstructorArgs,
    updateContractUTXOs,
    getContractUnlockFunction, // Added function to the exported object
  };

  // ------------------------
  // Helpers
  // ------------------------

  // ------------------------
  // Public API
  // ------------------------

  async function fetchConstructorArgs(address: string) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    const query =
      'SELECT constructor_args FROM cashscript_addresses WHERE address = ?';
    const statement = db.prepare(query);
    statement.bind([address]);

    let constructorArgs: unknown[] | null = null;
    if (statement.step()) {
      const row = statement.getAsObject() as SqlRow;
      constructorArgs = parseJsonOr<unknown[] | null>(row.constructor_args, null);
    }
    statement.free();
    return constructorArgs;
  }

  async function createContract(
    artifactName: string,
    constructorArgs: unknown[],
    currentNetwork: Network
  ) {
    try {
      const artifact = await loadArtifact(artifactName);
      if (!artifact) {
        throw new Error(`Artifact ${artifactName} could not be loaded`);
      }

      const provider = new ElectrumNetworkProvider(currentNetwork);
      const addressType = 'p2sh32';
      const prefix =
        currentNetwork === Network.MAINNET ? 'bitcoincash' : 'bchtest';

      if (
        Array.isArray(artifact.constructorInputs) &&
        artifact.constructorInputs.length > 0 &&
        (!constructorArgs ||
          constructorArgs.length !== artifact.constructorInputs.length)
      ) {
        throw new Error('Constructor arguments are required');
      }

      const parsedArgs = (constructorArgs || []).map((arg, index) =>
        parseInputValue(arg, artifact.constructorInputs[index].type)
      );

      const contract = new Contract(artifact as ContractCtorArtifact, parsedArgs, {
        provider,
        addressType,
      });

      const balance = await contract.getBalance();
      const utxos = await ElectrumService.getUTXOs(contract.address);

      const formattedUTXOs: StoredContractUtxo[] = utxos.map((utxo) =>
        toStoredContractUtxo(utxo, prefix, false)
      );

      await saveContractArtifact(artifact);

      const existingContract = await getContractInstanceByAddress(
        contract.address
      );
      if (!existingContract) {
        await saveContractInstance(
          artifact.contractName,
          contract,
          balance,
          formattedUTXOs,
          artifact.abi,
          artifact
        );

        await saveConstructorArgs(contract.address, constructorArgs, balance);
      }

      await dbService.saveDatabaseToFile();

      return {
        address: contract.address,
        tokenAddress: contract.tokenAddress,
        opcount: contract.opcount,
        bytesize: contract.bytesize,
        bytecode: contract.bytecode,
        balance,
        utxos: formattedUTXOs,
        abi: artifact.abi,
        redeemScript: contract.redeemScript,
        unlock: serializeUnlockFunctions(contract.unlock),
      };
    } catch (error) {
      console.error('Error creating contract:', error);
      throw error;
    }
  }

  async function saveConstructorArgs(
    address: string,
    constructorArgs: unknown[],
    balance: bigint
  ) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    const insertQuery = `
      INSERT INTO cashscript_addresses 
      (address, constructor_args, balance) 
      VALUES (?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET constructor_args=excluded.constructor_args, balance=excluded.balance
    `;

    const params = [
      address,
      JSON.stringify(
        (constructorArgs || []).map((arg) =>
          typeof arg === 'bigint' ? arg.toString() : arg
        )
      ),
      balance.toString(),
    ];

    const statement = db.prepare(insertQuery);
    statement.run(params);
    statement.free();
  }

  async function saveContractInstance(
    contractName: string,
    contract: Contract,
    balance: bigint,
    utxos: Array<Record<string, unknown>>,
    abi: unknown[],
    artifact: unknown
  ) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    const insertQuery = `
      INSERT INTO instantiated_contracts 
      (contract_name, address, token_address, opcount, bytesize, bytecode, balance, utxos, created_at, updated_at, artifact, abi, redeemScript, unlock) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        balance=excluded.balance,
        utxos=excluded.utxos,
        updated_at=excluded.updated_at
    `;

    const params = [
      contractName,
      contract.address,
      contract.tokenAddress,
      contract.opcount,
      contract.bytesize,
      contract.bytecode,
      balance.toString(),
      JSON.stringify(
        (utxos || []).map((utxo) => ({
          ...utxo,
          amount:
            (utxo.amount as { toString?: () => string } | undefined)?.toString?.() ??
            String(utxo.amount),
        }))
      ),
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify(artifact),
      JSON.stringify(abi),
      JSON.stringify(contract.redeemScript),
      JSON.stringify(serializeUnlockFunctions(contract.unlock)),
    ];

    const statement = db.prepare(insertQuery);
    statement.run(params);
    statement.free();
  }

  async function deleteContractInstance(contractId: number) {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();

      const deleteQuery = 'DELETE FROM instantiated_contracts WHERE id = ?';
      const statement = db.prepare(deleteQuery);
      statement.run([contractId]);
      statement.free();
      await dbService.saveDatabaseToFile();
    } catch (error) {
      console.error('Error deleting contract instance:', error);
      throw error;
    }
  }

  async function fetchContractInstances() {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();

      const query = 'SELECT * FROM instantiated_contracts';
      const statement = db.prepare(query);

      const instances: ContractInstanceRow[] = [];
      while (statement.step()) {
        const row = statement.getAsObject();
        instances.push(parseContractInstanceRow(row));
      }
      statement.free();
      return instances;
    } catch (error) {
      console.error('Error fetching contract instances:', error);
      return [];
    }
  }

  async function getContractInstanceByAddress(address: string) {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();

      const query = 'SELECT * FROM instantiated_contracts WHERE address = ?';
      const statement = db.prepare(query);
      statement.bind([address]);

      let contractInstance: ContractInstanceRow | null = null;
      if (statement.step()) {
        const row = statement.getAsObject();
        contractInstance = parseContractInstanceRow(row);
      }
      statement.free();
      return contractInstance;
    } catch (error) {
      console.error('Error getting contract instance by address:', error);
      return null;
    }
  }

  /**
   * Load artifact by:
   * - builtin key (e.g. "p2pkh")
   * - addon key (e.g. "addon:<addonId>:<contractId>" or legacy "addon:<contractId>")
   */
  async function loadArtifact(artifactName: string): Promise<ContractArtifact | null> {
    const raw = String(artifactName ?? '').trim();
    if (!raw) return null;

    // Builtin first (robust)
    if (artifactCache[raw]) return artifactCache[raw];
    const key = raw.toLowerCase();
    if (artifactCache[key]) return artifactCache[key];

    // Match by artifact.contractName (case-insensitive)
    for (const k of Object.keys(artifactCache)) {
      const a = artifactCache[k];
      const cn = String(a?.contractName ?? '')
        .trim()
        .toLowerCase();
      if (cn && cn === key) return a;
    }

    // Addon resolution
    const parsed = normalizeAddonKey(raw);
    if (!parsed?.contractId) return null;

    await addonsInit;
    const manifests = addons.getAddons();

    const contract = findAddonContract(
      manifests,
      parsed.addonId,
      parsed.contractId
    );

    if (!contract) return null;

    return contract.cashscriptArtifact as ContractArtifact;
  }

  async function listAvailableArtifacts(): Promise<AvailableContractEntry[]> {
    try {
      const builtin: AvailableContractEntry[] = Object.keys(artifactCache).map(
        (key) => ({
          fileName: key,
          contractName: artifactCache[key].contractName,
          source: 'builtin',
        })
      );

      await addonsInit;

      const addonEntries: AvailableContractEntry[] = [];
      for (const m of addons.getAddons()) {
        for (const c of m.contracts) {
          addonEntries.push({
            fileName: `addon:${m.id}:${c.id}`,
            contractName: c.name,
            source: 'addon',
          });
        }
      }

      return [...builtin, ...addonEntries];
    } catch (error) {
      console.error('Error listing artifacts:', error);
      return [];
    }
  }

  async function saveContractArtifact(artifact: ContractArtifact) {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();

      const insertQuery = `
        INSERT INTO cashscript_artifacts 
        (contract_name, constructor_inputs, abi, bytecode, source, compiler_name, compiler_version, updated_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(contract_name) DO UPDATE SET
          constructor_inputs=excluded.constructor_inputs,
          abi=excluded.abi,
          bytecode=excluded.bytecode,
          source=excluded.source,
          compiler_name=excluded.compiler_name,
          compiler_version=excluded.compiler_version,
          updated_at=excluded.updated_at
      `;

      const params = [
        artifact.contractName,
        JSON.stringify(artifact.constructorInputs || []),
        JSON.stringify(artifact.abi || []),
        artifact.bytecode,
        artifact.source ?? 'unknown',
        artifact.compiler?.name ?? 'unknown',
        artifact.compiler?.version ?? 'unknown',
        artifact.updatedAt ?? new Date().toISOString(),
      ];

      const statement = db.prepare(insertQuery);
      statement.run(params);
      statement.free();
    } catch (error) {
      console.error('Error saving contract artifact:', error);
      throw error;
    }
  }

  async function getContractArtifact(
    contractName: string
  ): Promise<ContractArtifact | null> {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();

      const query =
        'SELECT * FROM cashscript_artifacts WHERE contract_name = ?';
      const statement = db.prepare(query);
      statement.bind([contractName]);

      let artifact: ContractArtifact | null = null;
      if (statement.step()) {
        const row = statement.getAsObject() as SqlRow;
        artifact = {
          contractName: String(row.contract_name),
          constructorInputs:
            typeof row.constructor_inputs === 'string'
              ? parseJsonOr<AbiInput[]>(row.constructor_inputs, [])
              : [],
          abi:
            typeof row.abi === 'string'
              ? parseJsonOr<AbiFunction[]>(row.abi, [])
              : [],
          bytecode: String(row.bytecode ?? ''),
          source: String(row.source ?? 'unknown'),
          compiler: {
            name: String(row.compiler_name ?? 'unknown'),
            version: String(row.compiler_version ?? 'unknown'),
          },
          updatedAt: String(row.updated_at ?? ''),
        };
      }
      statement.free();
      return artifact;
    } catch (error) {
      console.error('Error getting contract artifact:', error);
      return null;
    }
  }

  async function updateContractUTXOs(address: string) {
    const state = store.getState();

    try {
      const currentNetwork = state.network.currentNetwork;
      const prefix =
        currentNetwork === Network.MAINNET ? 'bitcoincash' : 'bchtest';

      const utxos: UTXO[] = await ElectrumService.getUTXOs(address);
      const formattedUTXOs = utxos.map((utxo) =>
        toStoredContractUtxo(utxo, prefix, true)
      );

      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();

      const contractInstance = await getContractInstanceByAddress(address);
      if (!contractInstance) {
        throw new Error(`Contract instance not found for address: ${address}`);
      }

      const artifact = await getContractArtifact(
        contractInstance.contract_name
      );
      if (!artifact) {
        throw new Error(
          `Artifact not found for contract: ${contractInstance.contract_name}`
        );
      }

      const constructorArgs = await fetchConstructorArgs(address);
      if (
        Array.isArray(artifact.constructorInputs) &&
        artifact.constructorInputs.length > 0 &&
        (!constructorArgs || constructorArgs.length === 0)
      ) {
        throw new Error(
          `Constructor arguments not found for contract at address: ${address}`
        );
      }

      const parsedConstructorArgs = (constructorArgs || []).map((arg, index) =>
        parseInputValue(arg, artifact.constructorInputs[index].type)
      );

      const provider = new ElectrumNetworkProvider(currentNetwork);
      const contract = new Contract(
        artifact as ContractCtorArtifact,
        parsedConstructorArgs,
        {
        provider,
        }
      );

      const updatedBalance = await contract.getBalance();

      const existingUTXOsQuery =
        'SELECT tx_hash, tx_pos FROM UTXOs WHERE address = ?';
      const existingStmt = db.prepare(existingUTXOsQuery);
      existingStmt.bind([address]);

      const existingUTXOs: StoredContractRow[] = [];
      while (existingStmt.step()) {
        const row = existingStmt.getAsObject() as SqlRow;
        existingUTXOs.push({
          tx_hash: String(row.tx_hash),
          tx_pos: Number(row.tx_pos),
        });
      }
      existingStmt.free();

      const existingSet = new Set(
        existingUTXOs.map((u) => outpointKey(u.tx_hash, u.tx_pos))
      );
      const newSet = new Set(
        formattedUTXOs.map((u) => outpointKey(u.tx_hash, u.tx_pos))
      );

      const newUTXOs = formattedUTXOs.filter(
        (u) => !existingSet.has(outpointKey(u.tx_hash, u.tx_pos))
      );
      const staleUTXOs = existingUTXOs.filter(
        (u) => !newSet.has(outpointKey(u.tx_hash, u.tx_pos))
      );

      db.run('BEGIN TRANSACTION');

      try {
        const insertUTXOQuery = `
          INSERT INTO UTXOs (address, height, tx_hash, tx_pos, amount, token, prefix, contractFunction, contractFunctionInputs) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const insertStmt = db.prepare(insertUTXOQuery);
        for (const u of newUTXOs) {
          insertStmt.run([
            address,
            u.height,
            u.tx_hash,
            u.tx_pos,
            u.amount.toString(),
            u.token ? JSON.stringify(u.token) : null,
            u.prefix,
            u.contractFunction || null,
            u.contractFunctionInputs || null,
          ]);
        }
        insertStmt.free();

        const deleteUTXOQuery = `
          DELETE FROM UTXOs WHERE address = ? AND tx_hash = ? AND tx_pos = ?
        `;
        const deleteStmt = db.prepare(deleteUTXOQuery);
        for (const u of staleUTXOs) {
          deleteStmt.run([address, u.tx_hash, u.tx_pos]);
        }
        deleteStmt.free();

        const updateContractQuery = `
          UPDATE instantiated_contracts 
          SET utxos = ?, balance = ?, updated_at = ?
          WHERE address = ?
        `;
        const updateParams = [
          JSON.stringify(
            formattedUTXOs.map((u) => ({
              ...u,
              amount: u.amount.toString(),
              contractFunction: u.contractFunction || null,
              contractFunctionInputs: u.contractFunctionInputs || null,
            }))
          ),
          updatedBalance.toString(),
          new Date().toISOString(),
          address,
        ];

        db.run(updateContractQuery, updateParams);

        db.run('COMMIT');
      } catch (transError) {
        db.run('ROLLBACK');
        throw transError;
      }

      return { added: newUTXOs.length, removed: staleUTXOs.length };
    } catch (error) {
      console.error('Error updating UTXOs and balance:', error);
      throw error;
    }
  }

  async function getContractUnlockFunction(
    utxo: UTXO,
    contractFunction: string,
    contractFunctionInputs: Record<string, unknown>
  ) {
    const state = store.getState();
    type UnlockContext = {
      artifact: ContractArtifact;
      abi: AbiFunction[];
    };

    // 1) Try DB instantiated contract first (current behavior)
    let contractInstance: UnlockContext | null = await getContractInstanceByAddress(
      utxo.address
    );

    // 2) Fallback: build from artifact directly (patient-0 / no DB)
    if (!contractInstance) {
      const name = utxo.contractName;
      if (!name) {
        throw new Error(
          `Contract instance not found for address ${utxo.address} and utxo.contractName is missing`
        );
      }

      // Prefer builtin/addon resolver first
      const artifact =
        (await loadArtifact(name)) ?? (await getContractArtifact(name));
      if (!artifact) {
        throw new Error(`Contract artifact not found for ${name}`);
      }

      contractInstance = {
        artifact,
        abi: artifact.abi ?? [],
      };
    }

    // 3) Constructor args
    // Allow contracts with ZERO constructor inputs (do not require DB lookups).
    const ctorSpec: AbiInput[] = Array.isArray(
      contractInstance.artifact?.constructorInputs
    )
      ? contractInstance.artifact.constructorInputs
      : [];

    let parsedConstructorArgs: unknown[] = [];
    if (ctorSpec.length > 0) {
      const constructorInputs =
        Array.isArray(utxo.contractConstructorArgs) &&
        utxo.contractConstructorArgs.length > 0
          ? utxo.contractConstructorArgs
          : await fetchConstructorArgs(utxo.address);

      parsedConstructorArgs = ctorSpec.map((input, index) => {
        const argValue = constructorInputs?.[index];
        if (argValue === undefined) {
          throw new Error(`Missing constructor argument for ${input.name}`);
        }
        return parseInputValue(argValue, input.type);
      });
    }

    const contract = new Contract(
      contractInstance.artifact as ContractCtorArtifact,
      parsedConstructorArgs,
      {
        provider: new ElectrumNetworkProvider(state.network.currentNetwork),
        addressType: 'p2sh32',
      }
    );

    const abiFunction = contractInstance.abi.find(
      (func) => func.name === contractFunction
    );

    if (!abiFunction) {
      throw new Error(
        `ABI function '${contractFunction}' not found in contract`
      );
    }

    const args = await Promise.all(
      (abiFunction.inputs ?? []).map(async (input) => {
        const inputValue = contractFunctionInputs[input.name];

        if (input.type === 'sig') {
          if (
            typeof inputValue !== 'string' ||
            inputValue.trim().length === 0
          ) {
            throw new Error(
              `Missing signature input for '${input.name}'. Use sigaddr:<address>.`
            );
          }

          const v = inputValue.trim();

          if (v.startsWith('sigaddr:')) {
            const addr = v.slice('sigaddr:'.length).trim();
            if (!addr) throw new Error(`Invalid sigaddr for '${input.name}'.`);

            const pk = await KeyService.fetchAddressPrivateKey(addr);
            if (!pk || pk.length === 0) {
              throw new Error(`Private key not found for sigaddr '${addr}'.`);
            }

            return new SignatureTemplate(pk, HashType.SIGHASH_ALL);
          }

          if (v.startsWith('sigkey:')) {
            const keyMaterial = v.slice('sigkey:'.length).trim();
            if (!keyMaterial)
              throw new Error(`Invalid sigkey for '${input.name}'.`);
            return new SignatureTemplate(keyMaterial, HashType.SIGHASH_ALL);
          }

          throw new Error(
            `Unsupported sig input for '${input.name}'. Use sigaddr:<address> (recommended) or sigkey:<wif|hex> (explicit).`
          );
        }

        return parseInputValue(inputValue, input.type);
      })
    );

    const unlocker = contract.unlock[contractFunction](...args);

    return {
      lockingBytecode: contract.redeemScript,
      unlocker,
    };
  }
}
