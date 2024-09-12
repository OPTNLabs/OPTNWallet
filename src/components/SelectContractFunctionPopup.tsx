// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import AddressSelectionPopup from './AddressSelectionPopup';
import {
  setSelectedFunction,
  setInputs,
  setInputValues,
} from '../redux/contractSlice';
import { encodePrivateKeyWif } from '@bitauth/libauth';
import KeyManager from '../apis/WalletManager/KeyManager';

// Function to convert a byte array to hex string
const hexString = (pkh) => {
  return Array.from(pkh, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const SelectContractFunctionPopup = ({
  contractABI,
  onClose,
  onFunctionSelect,
}) => {
  const [functions, setFunctions] = useState([]);
  const [selectedFunction, setSelectedFunction] = useState('');
  const [inputs, setInputs] = useState([]);
  const [inputValues, setInputValues] = useState({});
  const [placeholders, setPlaceholders] = useState({}); // Store placeholder values
  const [showAddressPopup, setShowAddressPopup] = useState(false);
  const [selectedInput, setSelectedInput] = useState(null);

  const keyManager = KeyManager();
  const dispatch = useDispatch();

  // Get the current walletId from the Redux store
  const walletId = useSelector((state) => state.wallet_id.currentWalletId);

  // Fetch the ABI functions
  useEffect(() => {
    if (!contractABI || !Array.isArray(contractABI)) {
      console.error('Contract ABI is null, undefined, or not an array');
      return;
    }

    const allFunctionNames = contractABI
      .filter((item) => item.type === 'function' || item.type === undefined)
      .map((item) => ({ name: item.name, inputs: item.inputs }))
      .filter(
        (item, index, self) =>
          self.findIndex((f) => f.name === item.name) === index
      );

    setFunctions(allFunctionNames);
  }, [contractABI]);

  const handleFunctionSelect = (e) => {
    const selectedFunctionName = e.target.value;
    setSelectedFunction(selectedFunctionName);

    const functionAbi = functions.find(
      (item) => item.name === selectedFunctionName
    );
    setInputs(functionAbi?.inputs || []);
    setInputValues({});
    setPlaceholders({}); // Reset placeholders on function select
  };

  // Handle manual input change
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setInputValues((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  // Handle the function selection and dispatch to Redux
  const handleSelect = () => {
    const inputValuesArray = inputs.map((input) => ({
      type: input.type,
      value: inputValues[input.name] || '',
    }));

    dispatch(setSelectedFunction(selectedFunction));
    dispatch(setInputs(inputs));
    dispatch(setInputValues(inputValues));

    onFunctionSelect(selectedFunction, inputValuesArray);
    onClose();
  };

  // Fetch keys based on the selected address and walletId
  const fetchKeysForAddress = async (address) => {
    try {
      if (walletId === 0) {
        throw new Error('Invalid walletId');
      }

      const keys = await keyManager.retrieveKeys(walletId); // Use walletId from the Redux store
      const selectedKey = keys.find((key) => key.address === address);

      if (selectedKey) {
        const publicKeyHex = hexString(selectedKey.publicKey);
        const privateKeyWif = encodePrivateKeyWif(
          selectedKey.privateKey,
          'testnet'
        );

        console.log(publicKeyHex);
        console.log(privateKeyWif);

        // Update placeholder values based on the selected input type (pubkey or sig)
        setPlaceholders((prev) => {
          let updatedPlaceholders = { ...prev };

          if (selectedInput === 'pubkey') {
            updatedPlaceholders['pubkey'] = publicKeyHex; // Only update pubkey placeholder
          } else if (selectedInput === 'sig') {
            updatedPlaceholders['sig'] = privateKeyWif; // Only update sig placeholder
          }

          console.log('Updated placeholders:', updatedPlaceholders);
          return updatedPlaceholders;
        });
      } else {
        console.error(`No keys found for address: ${address}`);
      }
    } catch (error) {
      console.error('Error fetching keys:', error);
    }
  };

  // Handle selecting an address from the AddressSelectionPopup
  const handleAddressSelect = (address) => {
    console.log('Selected Address:', address);
    fetchKeysForAddress(address); // Fetch the public and private keys based on the selected address
  };

  // Open the address popup for pubkey or sig selection
  const openAddressPopup = (inputType) => {
    setSelectedInput(inputType);
    setShowAddressPopup(true);
  };

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center">
      <div className="bg-white p-6 rounded shadow-lg w-96">
        <h2 className="text-xl font-semibold mb-4">Select a function</h2>
        <select
          className="border p-2 w-full mb-4"
          value={selectedFunction}
          onChange={handleFunctionSelect}
        >
          <option value="">Select a function</option>
          {functions.map((func, index) => (
            <option key={index} value={func.name}>
              {func.name}
            </option>
          ))}
        </select>
        <div className="mb-4">
          {inputs.map((input, index) => (
            <div key={index} className="mb-2">
              <label className="block text-sm font-medium text-gray-700">
                {input.name} ({input.type})
              </label>
              <input
                type="text"
                name={input.name} // Ensure this matches keys in inputValues (like 'pubkey', 'sig')
                value={inputValues[input.name] || ''} // Ensure inputValues has the correct key
                onChange={handleInputChange}
                className="border p-2 w-full"
                placeholder={placeholders[input.name] || `Enter ${input.name}`} // Use placeholder if present
              />
              {(input.type === 'pubkey' || input.type === 'sig') && (
                <button
                  className="bg-blue-500 text-white py-1 px-2 rounded mt-2"
                  onClick={() => openAddressPopup(input.type)}
                >
                  Select {input.type}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            className="bg-blue-500 text-white py-2 px-4 rounded mr-2"
            onClick={handleSelect}
          >
            Select
          </button>
          <button
            className="bg-gray-300 text-gray-700 py-2 px-4 rounded"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
        {showAddressPopup && (
          <AddressSelectionPopup
            onSelect={handleAddressSelect}
            onClose={() => setShowAddressPopup(false)}
          />
        )}
      </div>
    </div>
  );
};

export default SelectContractFunctionPopup;
