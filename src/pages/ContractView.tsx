// @ts-expect-error
import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import ContractManager from '../apis/ContractManager/ContractManager';
import { RootState } from '../redux/store';
import RegularUTXOs from '../components/RegularUTXOs';
import CashTokenUTXOs from '../components/CashTokenUTXOs';

const ContractView = () => {
  const [contractDetails, setContractDetails] = useState(null);
  const [error, setError] = useState(null);
  const [availableContracts, setAvailableContracts] = useState([]);
  const [selectedContractFile, setSelectedContractFile] = useState('');
  const [constructorArgs, setConstructorArgs] = useState([]);
  const [inputValues, setInputValues] = useState({});
  const [contractInstances, setContractInstances] = useState([]);
  const navigate = useNavigate();
  const wallet_id = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  useEffect(() => {
    const loadAvailableContracts = async () => {
      try {
        const contractManager = ContractManager();
        const contracts = contractManager.listAvailableArtifacts();
        if (!contracts || contracts.length === 0) {
          throw new Error('No available contracts found');
        }
        setAvailableContracts(contracts);
      } catch (err) {
        setError(err.message);
      }
    };

    const loadContractInstances = async () => {
      try {
        const contractManager = ContractManager();
        const instances = await contractManager.fetchContractInstances();
        setContractInstances(instances);
      } catch (err) {
        setError(err.message);
      }
    };

    loadAvailableContracts();
    loadContractInstances();
  }, []);

  useEffect(() => {
    const loadContractDetails = async () => {
      if (selectedContractFile) {
        try {
          const contractManager = ContractManager();
          const artifact = contractManager.loadArtifact(selectedContractFile);
          if (!artifact) {
            throw new Error(
              `Artifact ${selectedContractFile} could not be loaded`
            );
          }
          setConstructorArgs(artifact.constructorInputs || []);
        } catch (err) {
          setError(err.message);
        }
      }
    };

    loadContractDetails();
  }, [selectedContractFile]);

  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setInputValues({ ...inputValues, [name]: value });
  };

  const parseInputValue = (value, type) => {
    switch (type) {
      case 'int':
        return BigInt(value);
      case 'bool':
        return value === 'true';
      case 'string':
        return value;
      case 'bytes':
        return value; // Assuming input is provided in hex format
      case 'pubkey':
        return value; // Assuming input is provided in hex format
      case 'sig':
        return value; // Assuming input is provided in hex format
      case 'datasig':
        return value; // Assuming input is provided in hex format
      default:
        return value; // Default to string
    }
  };

  const createContract = async () => {
    try {
      const contractManager = ContractManager();

      const args =
        constructorArgs.map((arg) =>
          parseInputValue(inputValues[arg.name], arg.type)
        ) || [];
      console.log('Constructor Args:', constructorArgs);
      console.log('Input Values:', inputValues);
      console.log('Parsed Args:', args);

      if (
        constructorArgs.length > 0 &&
        args.length !== constructorArgs.length
      ) {
        throw new Error('All constructor arguments must be provided');
      }

      const contract = await contractManager.createContract(
        selectedContractFile,
        args
      );
      setContractDetails(contract);

      // Reload contract instances
      const instances = await contractManager.fetchContractInstances();
      setContractInstances(instances);
    } catch (err) {
      console.error('Error creating contract:', err);
      setError(err.message);
    }
  };

  const deleteContract = async (contractId) => {
    try {
      const contractManager = ContractManager();
      await contractManager.deleteContractInstance(contractId);

      // Reload contract instances
      const instances = await contractManager.fetchContractInstances();
      setContractInstances(instances);
    } catch (err) {
      setError(err.message);
    }
  };

  if (error) {
    return <div>Error: {error}</div>;
  }

  const returnHome = async () => {
    navigate(`/home/${wallet_id}`);
  };

  return (
    <div className="container mx-auto p-4">
      <h2 className="text-lg font-semibold mb-2">Select Contract</h2>
      <select
        className="border p-2 mb-4 w-full"
        value={selectedContractFile}
        onChange={(e) => setSelectedContractFile(e.target.value)}
      >
        <option value="">Select a contract</option>
        {availableContracts.map((contract, index) => (
          <option key={index} value={contract.fileName}>
            {contract.contractName}
          </option>
        ))}
      </select>

      {constructorArgs.length > 0 && (
        <div className="mb-4">
          <h2 className="text-lg font-semibold mb-2">Constructor Arguments</h2>
          {constructorArgs.map((arg, index) => (
            <div key={index} className="mb-4">
              <label className="block text-sm font-medium text-gray-700">
                {arg.name} ({arg.type})
              </label>
              <input
                type="text"
                name={arg.name}
                value={inputValues[arg.name] || ''}
                onChange={handleInputChange}
                className="border p-2 w-full"
              />
            </div>
          ))}
        </div>
      )}

      {selectedContractFile && (
        <button
          onClick={createContract}
          className="bg-blue-500 text-white py-2 px-4 rounded mb-4"
        >
          Create Contract
        </button>
      )}

      {contractInstances.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold mb-2">Instantiated Contracts</h2>
          <div className="overflow-y-auto max-h-96">
            <ul>
              {contractInstances.map((instance) => (
                <li
                  key={instance.id}
                  className="mb-4 p-4 border rounded bg-gray-100"
                >
                  <div>
                    <div className="mb-2 overflow-x-auto">
                      <strong>Contract Name:</strong> {instance.contract_name}
                    </div>
                    <div className="mb-2">
                      <strong>Address:</strong> {instance.address}
                    </div>
                    <div className="mb-2">
                      <strong>Token Address:</strong> {instance.token_address}
                    </div>
                    <div className="mb-2">
                      <strong>Opcount:</strong> {instance.opcount}
                    </div>
                    <div className="mb-2">
                      <strong>Bytesize:</strong> {instance.bytesize}
                    </div>
                    <div className="mb-2">
                      <strong>Bytecode:</strong> {instance.bytecode}
                    </div>
                    <div className="mb-2">
                      <strong>Balance:</strong> {instance.balance.toString()}{' '}
                      satoshis
                    </div>
                  </div>
                  <div className="mb-2">
                    <strong>UTXOs:</strong>
                    <RegularUTXOs
                      address={instance.address}
                      utxos={instance.utxos
                        .filter((utxo) => !utxo.token)
                        .map((utxo) => ({
                          ...utxo,
                          amount: utxo.amount.toString(),
                          tx_hash: utxo.tx_hash,
                          tx_pos: utxo.tx_pos,
                        }))}
                      loading={false}
                    />
                    <CashTokenUTXOs
                      address={instance.address}
                      utxos={instance.utxos
                        .filter((utxo) => utxo.token)
                        .map((utxo) => ({
                          ...utxo,
                          amount: utxo.amount.toString(),
                          tx_hash: utxo.txid,
                          tx_pos: utxo.vout,
                          token_data: {
                            amount: utxo.token.amount,
                            category: utxo.token.category,
                          },
                        }))}
                      loading={false}
                    />
                  </div>
                  <button
                    onClick={() => deleteContract(instance.id)}
                    className="bg-red-500 text-white py-2 px-4 my-2 rounded"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <button
        onClick={returnHome}
        className="w-full bg-red-500 text-white py-2 px-4 rounded-md hover:bg-red-600 transition duration-300 my-2"
      >
        Go Back
      </button>
    </div>
  );
};

export default ContractView;
