// @ts-nocheck
import { Contract, Network, ElectrumNetworkProvider } from 'cashscript';
import DatabaseService from '../DatabaseManager/DatabaseService';
import p2pkhArtifact from './artifacts/p2pkh.json';
import transferWithTimeoutArtifact from './artifacts/transfer_with_timeout.json';
import announcementArtifact from './artifacts/announcement.json';

export default function ContractManager() {
  const dbService = DatabaseService();

  return {
    createContract,
    saveContractArtifact,
    getContractArtifact,
    listAvailableArtifacts,
    deleteContractInstance,
    fetchContractInstances,
    loadArtifact,
  };

  async function createContract(artifactName, constructorArgs) {
    try {
      const artifact = loadArtifact(artifactName);
      if (!artifact) {
        throw new Error(`Artifact ${artifactName} could not be loaded`);
      }

      const provider = new ElectrumNetworkProvider(Network.CHIPNET);
      const addressType = 'p2sh32';

      if (
        artifact.constructorInputs.length > 0 &&
        (!args || args.length !== artifact.constructorInputs.length)
      ) {
        throw new Error('Constructor arguments are required');
      }

      console.log('Creating contract with:', artifact, constructorArgs);

      const contract = new Contract(artifact, constructorArgs, {
        provider,
        addressType,
      });

      console.log('Contract:', contract);

      // Fetch contract details
      const balance = await contract.getBalance();
      const utxos = await contract.getUtxos();

      // Save the contract artifact to the database
      await saveContractArtifact(artifact);

      // Save the contract instance to the database if not exists
      const existingContract = await getContractInstanceByAddress(
        contract.address
      );
      if (!existingContract) {
        await saveContractInstance(
          artifact.contractName,
          contract,
          balance,
          utxos
        );
      }

      return {
        address: contract.address,
        tokenAddress: contract.tokenAddress,
        opcount: contract.opcount,
        bytesize: contract.bytesize,
        bytecode: contract.bytecode,
        balance,
        utxos,
      };
    } catch (error) {
      console.error('Error creating contract:', error);
      throw error;
    }
  }

  async function saveContractArtifact(artifact) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    const insertQuery = `
      INSERT INTO cashscript_artifacts 
      (contract_name, constructor_inputs, abi, bytecode, source, compiler_name, compiler_version, updated_at) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
  }

  async function getContractArtifact(contractName) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    const query = 'SELECT * FROM cashscript_artifacts WHERE contract_name = ?';
    const statement = db.prepare(query);
    statement.bind([contractName]);

    let artifact = null;
    if (statement.step()) {
      const row = statement.getAsObject();
      artifact = {
        contractName: row.contract_name,
        constructorInputs: JSON.parse(row.constructor_inputs),
        abi: JSON.parse(row.abi),
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
  }

  function loadArtifact(artifactName) {
    try {
      const artifacts = {
        p2pkh: p2pkhArtifact,
        transfer_with_timeout: transferWithTimeoutArtifact,
        announcement: announcementArtifact,
      };

      const artifact = artifacts[artifactName];
      if (!artifact) {
        throw new Error(`Artifact ${artifactName} not found`);
      }
      return artifact;
    } catch (error) {
      console.error('Error loading artifact:', error);
      return null;
    }
  }

  function listAvailableArtifacts() {
    try {
      return [
        { fileName: 'p2pkh', contractName: p2pkhArtifact.contractName },
        {
          fileName: 'transfer_with_timeout',
          contractName: transferWithTimeoutArtifact.contractName,
        },
        {
          fileName: 'announcement',
          contractName: announcementArtifact.contractName,
        },
      ];
    } catch (error) {
      console.error('Error listing artifacts:', error);
      return [];
    }
  }

  async function saveContractInstance(contractName, contract, balance, utxos) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    const insertQuery = `
      INSERT INTO instantiated_contracts 
      (contract_name, address, token_address, opcount, bytesize, bytecode, balance, utxos, created_at) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      contractName,
      contract.address,
      contract.tokenAddress,
      contract.opcount,
      contract.bytesize,
      contract.bytecode,
      balance.toString(), // Convert balance to string
      JSON.stringify(
        utxos.map((utxo) => ({
          ...utxo,
          satoshis: utxo.satoshis.toString(), // Convert satoshis to string
        }))
      ),
      new Date().toISOString(),
    ];

    console.log('Inserting contract instance with params:', params);

    const statement = db.prepare(insertQuery);
    statement.run(params);
    statement.free();
    await dbService.saveDatabaseToFile();
  }

  async function deleteContractInstance(contractId) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    const deleteQuery = 'DELETE FROM instantiated_contracts WHERE id = ?';
    const statement = db.prepare(deleteQuery);
    statement.run([contractId]);
    statement.free();
    await dbService.saveDatabaseToFile();
  }

  async function fetchContractInstances() {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    const query = 'SELECT * FROM instantiated_contracts';
    const statement = db.prepare(query);

    const instances = [];
    while (statement.step()) {
      const row = statement.getAsObject();
      instances.push({
        ...row,
        balance: BigInt(row.balance), // Convert balance back to BigInt
        utxos: JSON.parse(row.utxos).map((utxo) => ({
          ...utxo,
          satoshis: BigInt(utxo.satoshis), // Convert satoshis back to BigInt
        })),
      });
    }
    statement.free();
    return instances;
  }

  async function getContractInstanceByAddress(address) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    const query = 'SELECT * FROM instantiated_contracts WHERE address = ?';
    const statement = db.prepare(query);
    statement.bind([address]);

    let contractInstance = null;
    if (statement.step()) {
      const row = statement.getAsObject();
      contractInstance = {
        ...row,
        balance: BigInt(row.balance), // Convert balance back to BigInt
        utxos: JSON.parse(row.utxos).map((utxo) => ({
          ...utxo,
          satoshis: BigInt(utxo.satoshis), // Convert satoshis back to BigInt
        })),
      };
    }
    statement.free();
    return contractInstance;
  }
}
