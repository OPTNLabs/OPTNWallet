// @ts-nocheck
import { Contract, Network, ElectrumNetworkProvider } from 'cashscript';
import DatabaseService from '../DatabaseManager/DatabaseService';
import path from 'path';
import fs from 'fs';

export default function ContractManager() {
  const dbService = DatabaseService();

  return {
    createContract,
    saveContractArtifact,
    getContractArtifact,
    loadArtifact,
  };

  async function createContract(artifact, constructorArgs) {
    const provider = new ElectrumNetworkProvider(Network.CHIPNET);
    const addressType = 'p2sh32';
    const contract = new Contract(artifact, constructorArgs, {
      provider,
      addressType,
    });

    // Fetch contract details
    const balance = await contract.getBalance();
    const utxos = await contract.getUtxos();

    // Save the contract artifact to the database
    await saveContractArtifact(artifact);

    return {
      address: contract.address,
      tokenAddress: contract.tokenAddress,
      opcount: contract.opcount,
      bytesize: contract.bytesize,
      bytecode: contract.bytecode,
      balance: await contract.getBalance(),
      utxos: await contract.getUtxos(),
    };
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
    const artifactPath = path.resolve(
      __dirname,
      'artifacts',
      `${artifactName}.json`
    );
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Artifact file ${artifactName}.json not found`);
    }
    const artifactData = fs.readFileSync(artifactPath, 'utf8');
    return JSON.parse(artifactData);
  }
}
