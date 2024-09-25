// src/pages/ContractView.tsx

import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import ContractManager from '../apis/ContractManager/ContractManager';
import KeyManager from '../apis/WalletManager/KeyManager'; // Import KeyManager
import { hexString } from '../utils/hex'; // Import the hex conversion utility
import { RootState } from '../redux/store';
import RegularUTXOs from '../components/RegularUTXOs';
import CashTokenUTXOs from '../components/CashTokenUTXOs';
import parseInputValue from '../utils/parseInputValue';
import AddressSelectionPopup from '../components/AddressSelectionPopup'; // Import the AddressSelectionPopup component

const ContractView = () => {
  const [contractDetails, setContractDetails] = useState(null);
  const [error, setError] = useState(null);
  const [availableContracts, setAvailableContracts] = useState([]);
  const [selectedContractFile, setSelectedContractFile] = useState('');
  const [constructorArgs, setConstructorArgs] = useState([]);
  const [inputValues, setInputValues] = useState({});
  const [contractInstances, setContractInstances] = useState([]);
  const [showAddressPopup, setShowAddressPopup] = useState(false); // Control address popup visibility
  const [currentArgName, setCurrentArgName] = useState(''); // Track the current constructor argument
  const keyManager = KeyManager(); // Initialize the KeyManager
  const navigate = useNavigate();
  const wallet_id = useSelector((state: RootState) => state.wallet_id.currentWalletId);
  const currentNetwork = useSelector((state: RootState) => state.network.currentNetwork);

  // Load available contracts and instances on mount
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
        console.error('Error loading available contracts:', err);
        setError(err.message);
      }
    };

    const loadContractInstances = async () => {
      try {
        const contractManager = ContractManager();
        const instances = await contractManager.fetchContractInstances();
        setContractInstances(instances);
      } catch (err) {
        console.error('Error loading contract instances:', err);
        setError(err.message);
      }
    };

    loadAvailableContracts();
    loadContractInstances();
  }, []);

  // Load contract details when a contract is selected
  useEffect(() => {
    const loadContractDetails = async () => {
      if (selectedContractFile) {
        try {
          const contractManager = ContractManager();
          const artifact = contractManager.loadArtifact(selectedContractFile);
          if (!artifact) {
            throw new Error(`Artifact ${selectedContractFile} could not be loaded`);
          }
          setConstructorArgs(artifact.constructorInputs || []);
        } catch (err) {
          console.error('Error loading contract details:', err);
          setError(err.message);
        }
      }
    };

    loadContractDetails();
  }, [selectedContractFile]);

  // Handle input changes for constructor arguments
  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setInputValues({ ...inputValues, [name]: value });
    console.log(`Input changed: ${name} = ${value}`); // Debugging log
  };

  // Handle address selection from the popup
  const handleAddressSelect = async (address: string) => {
    console.log(`Address selected for ${currentArgName}: ${address}`); // Debugging log
    
    // Fetch publicKey and pubkeyHash using KeyManager
    const keys = await keyManager.retrieveKeys(wallet_id);
    const selectedKey = keys.find((key) => key.address === address);

    if (selectedKey) {
      console.log('Selected Key Data:', selectedKey);
      console.log('Constructor Args:', constructorArgs);
      console.log('Current Arg Name:', currentArgName);

      // Find the constructor argument matching the currentArgName
      const matchedArg = constructorArgs.find((arg) => arg.name === currentArgName);

      if (matchedArg) {
        let valueToSet = '';

        // Check the argument type and convert the corresponding value
        if (matchedArg.type === 'pubkey') {
          valueToSet = hexString(selectedKey.publicKey); // Convert publicKey to hex string
          console.log(`Converted publicKey to hex string: ${valueToSet}`);
        } else if (matchedArg.type === 'bytes20') {
          valueToSet = hexString(selectedKey.pubkeyHash); // Convert pubkeyHash to hex string
          console.log(`Converted pubkeyHash to hex string: ${valueToSet}`);
        }

        // Set the converted value in the inputValues state
        setInputValues({ ...inputValues, [currentArgName]: valueToSet });
      } else {
        console.warn(`No matching constructor argument found for: ${currentArgName}`);
      }
    } else {
      console.warn(`No key found for address: ${address}`);
    }

    setShowAddressPopup(false);
    setCurrentArgName('');
  };

  // Create a new contract instance
  const createContract = async () => {
    try {
      const contractManager = ContractManager();

      // Parse input values based on constructor argument types
      const args = constructorArgs.map((arg) =>
        parseInputValue(inputValues[arg.name], arg.type)
      ) || [];
      console.log('Constructor Args:', constructorArgs);
      console.log('Input Values:', inputValues);
      console.log('Parsed Args:', args);

      if (constructorArgs.length > 0 && args.length !== constructorArgs.length) {
        throw new Error('All constructor arguments must be provided');
      }

      // Create the contract instance
      const contract = await contractManager.createContract(
        selectedContractFile,
        args,
        currentNetwork
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

  // Delete a contract instance
  const deleteContract = async (contractId) => {
    try {
      const contractManager = ContractManager();
      await contractManager.deleteContractInstance(contractId);

      // Reload contract instances
      const instances = await contractManager.fetchContractInstances();
      setContractInstances(instances);
    } catch (err) {
      console.error('Error deleting contract:', err);
      setError(err.message);
    }
  };

  // Update a contract instance's UTXOs
  const updateContract = async (address) => {
    try {
      const contractManager = ContractManager();
      const { added, removed } = await contractManager.updateContractUTXOs(address);

      console.log(`UTXOs updated. Added: ${added}, Removed: ${removed}`);

      // Reload contract instances to reflect updated UTXOs
      const instances = await contractManager.fetchContractInstances();
      setContractInstances(instances);
    } catch (err) {
      console.error('Error updating UTXOs:', err);
      setError(err.message);
    }
  };

  if (error) {
    return <div>Error: {error}</div>;
  }

  const returnHome = () => {
    navigate(`/home/${wallet_id}`);
  };

  return (
    <div className="container mx-auto p-4">
      {/* Header Image */}
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="max-w-full h-auto"
        />
      </div>

      {/* Contract Selection */}
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

      {/* Constructor Arguments */}
      {constructorArgs.length > 0 && (
        <div className="mb-4">
          <h2 className="text-lg font-semibold mb-2">Constructor Arguments</h2>
          {constructorArgs.map((arg, index) => {
            const isAddressType = arg.type === 'bytes20' || arg.type === 'pubkey';

            return (
              <div key={index} className="mb-4">
                <label className="block text-sm font-medium text-gray-700">
                  {arg.name} ({arg.type})
                </label>
                {isAddressType ? (
                  // Display address selection button for specific types
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setCurrentArgName(arg.name);
                        setShowAddressPopup(true);
                      }}
                      className="bg-blue-500 text-white py-2 px-4 rounded mb-2"
                    >
                      Select Address
                    </button>
                    {/* Display selected address */}
                    {inputValues[arg.name] && (
                      <div className="mt-2">
                        Selected {arg.type}: {inputValues[arg.name]}
                      </div>
                    )}
                  </>
                ) : (
                  // Regular input for other types
                  <input
                    type="text"
                    name={arg.name}
                    value={inputValues[arg.name] || ''}
                    onChange={handleInputChange}
                    className="border p-2 w-full"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create Contract Button */}
      {selectedContractFile && (
        <button
          onClick={createContract}
          className="bg-blue-500 text-white py-2 px-4 rounded mb-4"
        >
          Create Contract
        </button>
      )}

      {/* Address Selection Popup */}
      {showAddressPopup && (
        <AddressSelectionPopup
          onSelect={handleAddressSelect}
          onClose={() => {
            setShowAddressPopup(false);
            setCurrentArgName('');
          }}
        />
      )}

      {/* Display Contract Instances */}
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
                      <strong>Balance:</strong> {instance.balance.toString()} satoshis
                    </div>
                  </div>
                  {/* UTXOs Display */}
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
                  {/* Update and Delete Buttons */}
                  <button
                    onClick={() => updateContract(instance.address)}
                    className="bg-green-500 text-white py-2 px-4 my-2 rounded"
                  >
                    Update
                  </button>
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

      {/* Go Back Button */}
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
