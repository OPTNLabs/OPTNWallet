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

import p2pkhArtifact from './artifacts/p2pkh.json';
import bip38Artifact from './artifacts/bip38.json';
import transferWithTimeoutArtifact from './artifacts/transfer_with_timeout.json';
// import announcementArtifact from './artifacts/announcement.json';
import escrowArtifact from './artifacts/escrow.json';
import escrowMS2Artifact from './artifacts/escrowMS2.json';
import MSVault from './artifacts/MSVault.json';

import AddonsRegistry from '../../services/AddonsRegistry';
import type {
  AddonManifest,
  AddonContractDefinition,
} from '../../types/addons';

type AvailableContractEntry = {
  fileName: string;
  contractName: string;
  source: 'builtin' | 'addon';
};

export default function ContractManager() {
  const dbService = DatabaseService();

  // ---- Addons (no React hooks here; ContractManager is not a component) ----
  const addons = AddonsRegistry();

  // Kick off init once per service instance; safe even if BUILTIN_ADDONS is empty.
  const addonsInit = addons.init().catch((e) => {
    console.warn('[addons] init failed:', e);
  });

  // Cache artifacts in memory to avoid redundant loading
  const artifactCache: { [key: string]: any } = {
    p2pkh: p2pkhArtifact,
    transfer_with_timeout: transferWithTimeoutArtifact,
    // announcement: announcementArtifact,
    escrow: escrowArtifact,
    escrowMS2: escrowMS2Artifact,
    bip38: bip38Artifact,
    msVault: MSVault,
  };

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

  function parseContractInstance(row: any) {
    const contractInstance = {
      ...row,
      balance: BigInt(row.balance || 0),
      utxos:
        typeof row.utxos === 'string'
          ? JSON.parse(row.utxos).map((utxo: any) => ({
              ...utxo,
              amount: BigInt(utxo.amount),
              contractFunction: utxo.contractFunction || undefined,
              contractFunctionInputs: utxo.contractFunctionInputs
                ? JSON.parse(utxo.contractFunctionInputs)
                : undefined,
            }))
          : [],
      artifact:
        typeof row.artifact === 'string' ? JSON.parse(row.artifact) : null,
      abi: typeof row.abi === 'string' ? JSON.parse(row.abi) : [],
      redeemScript:
        typeof row.redeemScript === 'string'
          ? JSON.parse(row.redeemScript)
          : null,
      unlock: typeof row.unlock === 'string' ? JSON.parse(row.unlock) : null,
      updated_at: row.updated_at,
    };

    if (contractInstance.unlock) {
      contractInstance.unlock = Object.fromEntries(
        Object.entries(contractInstance.unlock).map(([key, funcStr]) => [
          key,
          new Function(`return ${funcStr}`)(),
        ])
      );
    }

    return contractInstance;
  }

  function normalizeAddonKey(key: string): {
    addonId?: string;
    contractId?: string;
  } | null {
    if (!key.startsWith('addon:')) return null;

    // Supported formats:
    // - addon:<addonId>:<contractId> (preferred)
    // - addon:<contractId> (legacy)
    const rest = key.slice('addon:'.length);
    if (!rest) return null;

    const parts = rest.split(':').filter(Boolean);

    if (parts.length === 1) {
      return { contractId: parts[0] }; // legacy
    }

    if (parts.length >= 2) {
      return { addonId: parts[0], contractId: parts.slice(1).join(':') };
    }

    return null;
  }

  function findAddonContract(
    manifests: AddonManifest[],
    addonId: string | undefined,
    contractId: string
  ): AddonContractDefinition | null {
    // If addonId is provided, search only that addon
    if (addonId) {
      const m = manifests.find((x) => x.id === addonId);
      if (!m) return null;
      return m.contracts.find((c) => c.id === contractId) || null;
    }

    // Legacy fallback: global search by contractId
    for (const m of manifests) {
      const found = m.contracts.find((c) => c.id === contractId);
      if (found) return found;
    }
    return null;
  }

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

    let constructorArgs: any[] | null = null;
    if (statement.step()) {
      const row = statement.getAsObject();
      try {
        constructorArgs =
          typeof (row as any).constructor_args === 'string'
            ? JSON.parse((row as any).constructor_args)
            : null;
      } catch (e) {
        console.error('Error parsing JSON:', e);
        constructorArgs = null;
      }
    }
    statement.free();
    return constructorArgs;
  }

  async function createContract(
    artifactName: string,
    constructorArgs: any[],
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

      const contract = new Contract(artifact, parsedArgs, {
        provider,
        addressType,
      });

      const balance = await contract.getBalance();
      const utxos = await ElectrumService.getUTXOs(contract.address);

      const formattedUTXOs = utxos.map((utxo: any) => ({
        tx_hash: utxo.tx_hash,
        tx_pos: utxo.tx_pos,
        amount: BigInt(utxo.value),
        height: utxo.height,
        token: utxo.token || undefined,
        prefix,
        contractFunction: utxo.contractFunction || undefined,
        contractFunctionInputs: utxo.contractFunctionInputs
          ? JSON.stringify(utxo.contractFunctionInputs)
          : undefined,
      }));

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
        unlock: Object.fromEntries(
          Object.entries(contract.unlock).map(([key, func]) => [
            key,
            func.toString(),
          ])
        ),
      };
    } catch (error) {
      console.error('Error creating contract:', error);
      throw error;
    }
  }

  async function saveConstructorArgs(
    address: string,
    constructorArgs: any[],
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
    utxos: any[],
    abi: any[],
    artifact: any
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
        (utxos || []).map((utxo: any) => ({
          ...utxo,
          amount: utxo.amount?.toString?.() ?? String(utxo.amount),
        }))
      ),
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify(artifact),
      JSON.stringify(abi),
      JSON.stringify(contract.redeemScript),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(contract.unlock).map(([key, func]) => [
            key,
            func.toString(),
          ])
        )
      ),
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

      const instances: any[] = [];
      while (statement.step()) {
        const row = statement.getAsObject();
        instances.push(parseContractInstance(row));
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

      let contractInstance: any = null;
      if (statement.step()) {
        const row = statement.getAsObject();
        contractInstance = parseContractInstance(row);
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
  async function loadArtifact(artifactName: string): Promise<any | null> {
    // Builtin first
    if (artifactCache[artifactName]) return artifactCache[artifactName];

    // Addon resolution
    const parsed = normalizeAddonKey(artifactName);
    if (!parsed?.contractId) return null;

    await addonsInit;
    const manifests = addons.getAddons();

    const contract = findAddonContract(
      manifests,
      parsed.addonId,
      parsed.contractId
    );

    if (!contract) return null;

    return contract.cashscriptArtifact as any;
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

  async function saveContractArtifact(artifact: any) {
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

  async function getContractArtifact(contractName: string) {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();

      const query =
        'SELECT * FROM cashscript_artifacts WHERE contract_name = ?';
      const statement = db.prepare(query);
      statement.bind([contractName]);

      let artifact: any = null;
      if (statement.step()) {
        const row: any = statement.getAsObject();
        artifact = {
          contractName: row.contract_name,
          constructorInputs:
            typeof row.constructor_inputs === 'string'
              ? JSON.parse(row.constructor_inputs)
              : [],
          abi: typeof row.abi === 'string' ? JSON.parse(row.abi) : [],
          bytecode: row.bytecode,
          source: row.source,
          compiler: {
            name: row.compiler_name,
            version: row.compiler_version,
          },
          updatedAt: row.updated_at,
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
      const formattedUTXOs = utxos.map((utxo: UTXO) => ({
        tx_hash: utxo.tx_hash,
        tx_pos: utxo.tx_pos,
        amount: BigInt(utxo.value),
        height: utxo.height,
        token: utxo.token || undefined,
        prefix,
        contractFunction: utxo.contractFunction || null,
        contractFunctionInputs: utxo.contractFunctionInputs
          ? JSON.stringify(utxo.contractFunctionInputs)
          : null,
      }));

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
      const contract = new Contract(artifact, parsedConstructorArgs, {
        provider,
      });

      const updatedBalance = await contract.getBalance();

      const existingUTXOsQuery =
        'SELECT tx_hash, tx_pos FROM UTXOs WHERE address = ?';
      const existingStmt = db.prepare(existingUTXOsQuery);
      existingStmt.bind([address]);

      const existingUTXOs: any[] = [];
      while (existingStmt.step()) {
        const row = existingStmt.getAsObject();
        existingUTXOs.push(row);
      }
      existingStmt.free();

      const existingSet = new Set(
        existingUTXOs.map((u) => `${(u as any).tx_hash}:${(u as any).tx_pos}`)
      );
      const newSet = new Set(
        formattedUTXOs.map((u) => `${u.tx_hash}:${u.tx_pos}`)
      );

      const newUTXOs = formattedUTXOs.filter(
        (u) => !existingSet.has(`${u.tx_hash}:${u.tx_pos}`)
      );
      const staleUTXOs = existingUTXOs.filter(
        (u) => !newSet.has(`${(u as any).tx_hash}:${(u as any).tx_pos}`)
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
          deleteStmt.run([address, (u as any).tx_hash, (u as any).tx_pos]);
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
    contractFunctionInputs: { [key: string]: any }
  ) {
    const state = store.getState();

    const contractInstance = await getContractInstanceByAddress(utxo.address);
    if (!contractInstance) {
      throw new Error(
        `Contract instance not found for address ${utxo.address}`
      );
    }

    const constructorInputs = await fetchConstructorArgs(utxo.address);

    const parsedConstructorArgs =
      contractInstance.artifact.constructorInputs.map(
        (input: any, index: number) => {
          const argValue = constructorInputs[index];
          if (argValue === undefined) {
            throw new Error(`Missing constructor argument for ${input.name}`);
          }
          return parseInputValue(argValue, input.type);
        }
      );

    const contract = new Contract(
      contractInstance.artifact,
      parsedConstructorArgs,
      {
        provider: new ElectrumNetworkProvider(state.network.currentNetwork),
        addressType: 'p2sh32',
      }
    );

    const abiFunction = contractInstance.abi.find(
      (func: any) => func.name === contractFunction
    );

    if (!abiFunction) {
      throw new Error(
        `ABI function '${contractFunction}' not found in contract`
      );
    }

    const args = await Promise.all(
      abiFunction.inputs.map(async (input: any) => {
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
