// @ts-ignore
import { Contract, ElectrumNetworkProvider } from 'cashscript';
import DatabaseService from '../DatabaseManager/DatabaseService';
import p2pkhArtifact from './artifacts/p2pkh.json';
import IntrospectionCovenant from './artifacts/IntrospectionCovenant.json';
import transferWithTimeoutArtifact from './artifacts/transfer_with_timeout.json';
import announcementArtifact from './artifacts/announcement.json';
import ElectrumService from '../ElectrumServer/ElectrumServer';
import parseInputValue from '../../utils/parseInputValue';

export default function ContractManager() {
  const dbService = DatabaseService();
  const electrum = ElectrumService();

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
  };

  // Add the fetchConstructorArgs method
  async function fetchConstructorArgs(address: string) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    const query =
      'SELECT constructor_args FROM cashscript_addresses WHERE address = ?';
    const statement = db.prepare(query);
    statement.bind([address]);

    console.log('statement', statement);

    console.log('Address:', address); // Debugging line

    let constructorArgs = null;
    if (statement.step()) {
      const row = statement.getAsObject();
      console.log('Row:', row); // Debugging line
      try {
        constructorArgs = JSON.parse(row.constructor_args);
      } catch (e) {
        console.error('Error parsing JSON:', e); // Log the error for debugging
        constructorArgs = null;
      }
    }
    statement.free();
    return constructorArgs;
  }

  async function createContract(artifactName, constructorArgs, currentNetwork) {
    try {
      const artifact = loadArtifact(artifactName);
      if (!artifact) {
        throw new Error(`Artifact ${artifactName} could not be loaded`);
      }

      const provider = new ElectrumNetworkProvider(currentNetwork);
      const addressType = 'p2sh32';

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

      console.log('Creating contract with:', artifact, parsedArgs);

      const contract = new Contract(artifact, parsedArgs, {
        provider,
        addressType,
      });

      console.log('Contract:', contract);

      const balance = await contract.getBalance();
      console.log('Balance', balance);
      const utxos = await electrum.getUTXOS(contract.address);

      const formattedUTXOs = utxos.map((utxo) => ({
        tx_hash: utxo.tx_hash,
        tx_pos: utxo.tx_pos,
        amount: BigInt(utxo.value),
        height: utxo.height,
        token: utxo.token_data ? utxo.token_data : undefined,
      }));
      console.log('Formatted UTXOs:', formattedUTXOs);

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
        unlock: Object.keys(contract.unlock).reduce((acc, key) => {
          acc[key] = contract.unlock[key].toString();
          return acc;
        }, {}),
      };
    } catch (error) {
      console.error('Error creating contract:', error);
      throw error;
    }
  }

  async function saveConstructorArgs(address, constructorArgs, balance) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    const insertQuery = `
      INSERT INTO cashscript_addresses 
      (address, constructor_args, balance) 
      VALUES (?, ?, ?)
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
    contractName,
    contract,
    balance,
    utxos,
    abi,
    artifact
  ) {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    console.log('balance:', balance);

    const insertQuery = `
      INSERT INTO instantiated_contracts 
      (contract_name, address, token_address, opcount, bytesize, bytecode, balance, utxos, created_at, artifact, abi, redeemScript, unlock) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        utxos.map((utxo) => ({
          ...utxo,
          amount: utxo.amount.toString(),
        }))
      ),
      new Date().toISOString(),
      JSON.stringify(artifact),
      JSON.stringify(abi),
      JSON.stringify(contract.redeemScript),
      JSON.stringify(
        Object.keys(contract.unlock).reduce((acc, key) => {
          acc[key] = contract.unlock[key].toString();
          return acc;
        }, {})
      ),
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
      console.log(row);
      instances.push({
        ...row,
        balance:
          typeof row.balance === 'number' ? BigInt(row.balance) : BigInt(0),
        utxos:
          typeof row.utxos === 'string'
            ? JSON.parse(row.utxos).map((utxo) => ({
                ...utxo,
                amount: BigInt(utxo.amount), // Convert back to BigInt
              }))
            : [],
        artifact: JSON.parse(row.artifact),
        abi: JSON.parse(row.abi),
        redeemScript: JSON.parse(row.redeemScript),
        unlock: JSON.parse(row.unlock),
      });

      // Recreate the unlock functions
      if (instances[instances.length - 1].unlock) {
        const unlockFunctions = {};
        Object.keys(instances[instances.length - 1].unlock).forEach((key) => {
          unlockFunctions[key] = new Function(
            'return ' + instances[instances.length - 1].unlock[key]
          )();
        });
        instances[instances.length - 1].unlock = unlockFunctions;
      }
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
        balance:
          typeof row.balance === 'number' ? BigInt(row.balance) : BigInt(0),
        utxos:
          typeof row.utxos === 'string'
            ? JSON.parse(row.utxos).map((utxo) => ({
                ...utxo,
                amount: BigInt(utxo.amount), // Convert back to BigInt
              }))
            : [],
        artifact: JSON.parse(row.artifact),
        abi: JSON.parse(row.abi),
        redeemScript: JSON.parse(row.redeemScript),
        unlock: JSON.parse(row.unlock),
      };

      // Recreate the unlock functions
      if (contractInstance.unlock) {
        const unlockFunctions = {};
        Object.keys(contractInstance.unlock).forEach((key) => {
          unlockFunctions[key] = new Function(
            'return ' + contractInstance.unlock[key]
          )();
        });
        contractInstance.unlock = unlockFunctions;
      }
    }
    statement.free();
    return contractInstance;
  }

  function loadArtifact(artifactName) {
    try {
      const artifacts = {
        p2pkh: p2pkhArtifact,
        transfer_with_timeout: transferWithTimeoutArtifact,
        announcement: announcementArtifact,
        IntrospectionCovenant: IntrospectionCovenant,
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
        {
          fileName: 'IntrospectionCovenant',
          contractName: IntrospectionCovenant.contractName,
        },
      ];
    } catch (error) {
      console.error('Error listing artifacts:', error);
      return [];
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
  }

  async function updateContractUTXOs(address) {
    try {
      const utxos = await electrum.getUTXOS(address);
      const formattedUTXOs = utxos.map((utxo) => ({
        tx_hash: utxo.tx_hash,
        tx_pos: utxo.tx_pos,
        amount: BigInt(utxo.value),
        height: utxo.height,
        token: utxo.token_data ? utxo.token_data : null,
        prefix: 'bchtest', // Ensure prefix is provided
      }));

      console.log('Fetched UTXOs:', formattedUTXOs);

      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();

      // Fetch existing UTXOs from the database for this address
      const query = 'SELECT tx_hash, tx_pos FROM UTXOs WHERE address = ?';
      const statement = db.prepare(query);
      statement.bind([address]);

      const existingUTXOs = [];
      while (statement.step()) {
        const row = statement.getAsObject();
        existingUTXOs.push(row);
      }
      statement.free();

      // Identify UTXOs to add or remove
      const newUTXOs = formattedUTXOs.filter(
        (utxo) =>
          !existingUTXOs.some(
            (existing) =>
              existing.tx_hash === utxo.tx_hash &&
              existing.tx_pos === utxo.tx_pos
          )
      );

      const staleUTXOs = existingUTXOs.filter(
        (existing) =>
          !formattedUTXOs.some(
            (utxo) =>
              utxo.tx_hash === existing.tx_hash &&
              utxo.tx_pos === existing.tx_pos
          )
      );

      console.log('New UTXOs:', newUTXOs);
      console.log('Stale UTXOs:', staleUTXOs);

      // Add new UTXOs to the database
      const insertQuery = `
        INSERT INTO UTXOs (address, height, tx_hash, tx_pos, amount, token_data, prefix) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      for (const utxo of newUTXOs) {
        console.log('Adding UTXO:', utxo);
        const insertStatement = db.prepare(insertQuery);
        insertStatement.run([
          address,
          utxo.height,
          utxo.tx_hash,
          utxo.tx_pos,
          utxo.amount.toString(),
          utxo.token ? JSON.stringify(utxo.token) : null,
          utxo.prefix,
        ]);
        insertStatement.free();
      }

      // Remove stale UTXOs from the database
      const deleteQuery =
        'DELETE FROM UTXOs WHERE address = ? AND tx_hash = ? AND tx_pos = ?';
      for (const utxo of staleUTXOs) {
        console.log('Removing stale UTXO:', utxo);
        const deleteStatement = db.prepare(deleteQuery);
        deleteStatement.run([address, utxo.tx_hash, utxo.tx_pos]);
        deleteStatement.free();
      }

      await dbService.saveDatabaseToFile();
      return { added: newUTXOs.length, removed: staleUTXOs.length };
    } catch (error) {
      console.error('Error updating UTXOs:', error);
      throw error;
    }
  }
}
