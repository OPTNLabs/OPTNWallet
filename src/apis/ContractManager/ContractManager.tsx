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
import { UTXO } from '../../types/types';
import p2pkhArtifact from './artifacts/p2pkh.json';
// import bip38Artifact from './artifacts/bip38.json';
import transferWithTimeoutArtifact from './artifacts/transfer_with_timeout.json';
// import announcementArtifact from './artifacts/announcement.json';
import escrowArtifact from './artifacts/escrow.json';
import escrowMS2Artifact from './artifacts/escrowMS2.json';

export default function ContractManager() {
  const dbService = DatabaseService();
  const state = store.getState();

  // Cache artifacts in memory to avoid redundant loading
  const artifactCache: { [key: string]: any } = {
    p2pkh: p2pkhArtifact,
    transfer_with_timeout: transferWithTimeoutArtifact,
    // announcement: announcementArtifact,
    escrow: escrowArtifact,
    escrowMS2: escrowMS2Artifact,
    // bip38: bip38Artifact,
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

  // Helper function to parse contract instance from DB row
  function parseContractInstance(row: any) {
    const contractInstance = {
      ...row,
      balance: BigInt(row.balance || 0),
      utxos:
        typeof row.utxos === 'string'
          ? JSON.parse(row.utxos).map((utxo: any) => ({
              ...utxo,
              amount: BigInt(utxo.amount),
              contractFunction: utxo.contractFunction || undefined, // New Field
              contractFunctionInputs: utxo.contractFunctionInputs
                ? JSON.parse(utxo.contractFunctionInputs)
                : undefined, // New Field
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
      updated_at: row.updated_at, // Ensure updated_at is included
    };

    if (contractInstance.unlock) {
      contractInstance.unlock = Object.fromEntries(
        Object.entries(contractInstance.unlock).map(([key, funcStr]) => [
          key,
          new Function(`return ${funcStr}`)(),
        ])
      );
    }

    // **Add Logging Here**
    // console.log('Parsed Contract Instance:', contractInstance);

    return contractInstance;
  }

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
          typeof row.constructor_args === 'string'
            ? JSON.parse(row.constructor_args)
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
      const artifact = loadArtifact(artifactName);
      if (!artifact) {
        throw new Error(`Artifact ${artifactName} could not be loaded`);
      }

      const provider = new ElectrumNetworkProvider(currentNetwork);
      const addressType = 'p2sh32';
      const prefix =
        currentNetwork === Network.MAINNET ? 'bitcoincash' : 'bchtest';

      if (
        artifact.constructorInputs.length > 0 &&
        (!constructorArgs ||
          constructorArgs.length !== artifact.constructorInputs.length)
      ) {
        throw new Error('Constructor arguments are required');
      }

      const parsedArgs = constructorArgs.map((arg, index) =>
        parseInputValue(arg, artifact.constructorInputs[index].type)
      );

      const contract = new Contract(artifact, parsedArgs, {
        provider,
        addressType,
      });

      const balance = await contract.getBalance();
      const utxos = await ElectrumService.getUTXOS(contract.address);

      const formattedUTXOs = utxos.map((utxo: any) => ({
        tx_hash: utxo.tx_hash,
        tx_pos: utxo.tx_pos,
        amount: BigInt(utxo.value),
        height: utxo.height,
        token: utxo.token || undefined,
        prefix,
        // **Add New Fields**
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

        // Save constructor arguments to the database
        await saveConstructorArgs(contract.address, constructorArgs, balance);
      }

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
        constructorArgs.map((arg) =>
          typeof arg === 'bigint' ? arg.toString() : arg
        )
      ),
      balance.toString(),
    ];

    const statement = db.prepare(insertQuery);
    statement.run(params);
    statement.free();
    await dbService.saveDatabaseToFile();
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
        utxos.map((utxo) => ({ ...utxo, amount: utxo.amount.toString() }))
      ),
      new Date().toISOString(),
      new Date().toISOString(), // Set updated_at to current time
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

    // **Add Logging Before Saving**
    // console.log('Saving contract instance with params:', params);

    const statement = db.prepare(insertQuery);
    statement.run(params);
    statement.free();
    await dbService.saveDatabaseToFile();

    // **Add Logging After Saving**
    // console.log('Contract instance saved successfully.');
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

      const instances = [];
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

  function loadArtifact(artifactName: string) {
    return artifactCache[artifactName] || null;
  }

  function listAvailableArtifacts() {
    try {
      return Object.keys(artifactCache).map((key) => ({
        fileName: key,
        contractName: artifactCache[key].contractName,
      }));
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
        JSON.stringify(artifact.constructorInputs),
        JSON.stringify(artifact.abi),
        artifact.bytecode,
        artifact.source,
        artifact.compiler.name,
        artifact.compiler.version,
        artifact.updatedAt,
      ];

      const statement = db.prepare(insertQuery);
      statement.run(params);
      statement.free();
      await dbService.saveDatabaseToFile();
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
        const row = statement.getAsObject();
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
    try {
      const currentNetwork = state.network.currentNetwork;
      const prefix =
        currentNetwork === Network.MAINNET ? 'bitcoincash' : 'bchtest';

      const utxos: UTXO[] = await ElectrumService.getUTXOS(address);
      const formattedUTXOs = utxos.map((utxo: UTXO) => ({
        tx_hash: utxo.tx_hash,
        tx_pos: utxo.tx_pos,
        amount: BigInt(utxo.value),
        height: utxo.height,
        token: utxo.token || undefined,
        prefix,
        contractFunction: utxo.contractFunction || null, // New Field
        contractFunctionInputs: utxo.contractFunctionInputs
          ? JSON.stringify(utxo.contractFunctionInputs)
          : null, // New Field
      }));

      // **Add Logging After Formatting UTXOs**
      // console.log('Formatted UTXOs with new fields:', formattedUTXOs);

      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();

      // Fetch contract instance
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
      if (!constructorArgs || constructorArgs.length === 0) {
        throw new Error(
          `Constructor arguments not found for contract at address: ${address}`
        );
      }

      const parsedConstructorArgs = constructorArgs.map((arg, index) =>
        parseInputValue(arg, artifact.constructorInputs[index].type)
      );

      const provider = new ElectrumNetworkProvider(currentNetwork);
      const contract = new Contract(artifact, parsedConstructorArgs, {
        provider,
      });

      const updatedBalance = await contract.getBalance();

      // Fetch existing UTXOs from the database
      const existingUTXOsQuery =
        'SELECT tx_hash, tx_pos FROM UTXOs WHERE address = ?';
      const existingStmt = db.prepare(existingUTXOsQuery);
      existingStmt.bind([address]);

      const existingUTXOs = [];
      while (existingStmt.step()) {
        const row = existingStmt.getAsObject();
        existingUTXOs.push(row);
      }
      existingStmt.free();

      // Determine new and stale UTXOs using Sets for efficiency
      const existingSet = new Set(
        existingUTXOs.map((utxo) => `${utxo.tx_hash}:${utxo.tx_pos}`)
      );
      const newSet = new Set(
        formattedUTXOs.map((utxo) => `${utxo.tx_hash}:${utxo.tx_pos}`)
      );

      const newUTXOs = formattedUTXOs.filter(
        (utxo) => !existingSet.has(`${utxo.tx_hash}:${utxo.tx_pos}`)
      );
      const staleUTXOs = existingUTXOs.filter(
        (utxo) => !newSet.has(`${utxo.tx_hash}:${utxo.tx_pos}`)
      );

      // Begin transaction for batch operations
      db.run('BEGIN TRANSACTION');

      try {
        // Batch insert new UTXOs
        const insertUTXOQuery = `
          INSERT INTO UTXOs (address, height, tx_hash, tx_pos, amount, token, prefix, contractFunction, contractFunctionInputs) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const insertStmt = db.prepare(insertUTXOQuery);
        for (const utxo of newUTXOs) {
          insertStmt.run([
            address,
            utxo.height,
            utxo.tx_hash,
            utxo.tx_pos,
            utxo.amount.toString(),
            utxo.token ? JSON.stringify(utxo.token) : null,
            utxo.prefix,
            utxo.contractFunction || null, // New Field
            utxo.contractFunctionInputs || null, // New Field
          ]);
        }
        insertStmt.free();

        // Batch delete stale UTXOs
        const deleteUTXOQuery = `
          DELETE FROM UTXOs WHERE address = ? AND tx_hash = ? AND tx_pos = ?
        `;
        const deleteStmt = db.prepare(deleteUTXOQuery);
        for (const utxo of staleUTXOs) {
          deleteStmt.run([address, utxo.tx_hash, utxo.tx_pos]);
        }
        deleteStmt.free();

        // Update the instantiated_contracts table with new UTXOs and updated balance
        const updateContractQuery = `
          UPDATE instantiated_contracts 
          SET utxos = ?, balance = ?, updated_at = ?
          WHERE address = ?
        `;
        const updateParams = [
          JSON.stringify(
            formattedUTXOs.map((utxo) => ({
              ...utxo,
              amount: utxo.amount.toString(),
              // **Ensure new fields are included**
              contractFunction: utxo.contractFunction || null,
              contractFunctionInputs: utxo.contractFunctionInputs || null,
            }))
          ),
          updatedBalance.toString(),
          new Date().toISOString(), // Update the updated_at timestamp
          address,
        ];

        // **Add Logging Before Update**
        // console.log(
        //   'Updating instantiated_contracts with params:',
        //   updateParams
        // );

        db.run(updateContractQuery, updateParams);

        // Commit transaction
        db.run('COMMIT');
      } catch (transError) {
        // Rollback transaction on error
        db.run('ROLLBACK');
        throw transError;
      }

      await dbService.saveDatabaseToFile();
      return { added: newUTXOs.length, removed: staleUTXOs.length };
    } catch (error) {
      console.error('Error updating UTXOs and balance:', error);
      throw error;
    }
  }

  // New Function: getContractUnlockFunction
  async function getContractUnlockFunction(
    utxo: UTXO,
    contractFunction: string,
    contractFunctionInputs: { [key: string]: any }
  ) {
    // Log the contract function inputs before processing
    // console.log('Processing UTXO for unlock function:', utxo);
    // console.log('Contract Function:', contractFunction);
    // console.log('Contract Function Inputs:', contractFunctionInputs);

    // console.log('Fetching contract instance for UTXO address:', utxo.address);

    // Fetch the contract instance for the UTXO's address
    const contractInstance = await getContractInstanceByAddress(utxo.address);

    if (!contractInstance) {
      throw new Error(
        `Contract instance not found for address ${utxo.address}`
      );
    }

    // console.log('Contract instance fetched:', contractInstance);
    // console.log('Contract artifact:', contractInstance.artifact);

    // Fetch constructor inputs for the contract
    const constructorInputs = await fetchConstructorArgs(utxo.address);
    // console.log('Fetched constructor inputs:', constructorInputs);

    // Parse constructor arguments using the contract's artifact
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

    // console.log('Parsed constructor arguments:', parsedConstructorArgs);

    // Create a new contract instance with parsed constructor arguments
    const contract = new Contract(
      contractInstance.artifact,
      parsedConstructorArgs,
      {
        provider: new ElectrumNetworkProvider(state.network.currentNetwork),
        addressType: 'p2sh32',
      }
    );

    // console.log(
    //   'Created contract instance with parsed constructor arguments:',
    //   contract
    // );

    // Find the ABI function in the contract using the provided function name
    const abiFunction = contractInstance.abi.find(
      (func: any) => func.name === contractFunction
    );

    // console.log(
    //   'ABI function for contractFunction:',
    //   contractFunction,
    //   '\nABI Function:',
    //   abiFunction,
    //   '\nContract Function Inputs:',
    //   contractFunctionInputs
    // );

    if (!abiFunction) {
      throw new Error(
        `ABI function '${contractFunction}' not found in contract`
      );
    }

    // Create unlocker with function inputs
    const unlocker = contract.unlock[contractFunction](
      ...abiFunction.inputs.map((input: any) => {
        // Get the corresponding value from contractFunctionInputs using the input name
        const inputValue = contractFunctionInputs[input.name];

        // Check if the input type is 'sig' (for signature)
        if (input.type === 'sig') {
          // Handle signature input with `SignatureTemplate`
          return new SignatureTemplate(inputValue, HashType.SIGHASH_ALL);
        } else {
          // For other inputs, parse the input value based on its type
          return parseInputValue(inputValue, input.type);
        }
      })
    );

    // console.log('Generated unlocker for contract function:', unlocker);

    return {
      lockingBytecode: contract.redeemScript,
      unlocker,
    };
  }
}
