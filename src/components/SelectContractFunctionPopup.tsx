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
import { RootState, AppDispatch } from '../redux/store';
import { hexString } from '../utils/hex';

interface SelectContractFunctionPopupProps {
  contractABI: any[];
  onClose: () => void;
  onFunctionSelect: (
    selectedFunction: string,
    inputValues: { [key: string]: string }
  ) => void;
}

const SelectContractFunctionPopup: React.FC<
  SelectContractFunctionPopupProps
> = ({ contractABI, onClose, onFunctionSelect }) => {
  const [functions, setFunctions] = useState<any[]>([]);
  const [selectedFunction, setSelectedFunctionState] = useState<string>('');
  const [inputs, setInputsState] = useState<any[]>([]);
  const [inputValues, setInputValuesState] = useState<{
    [key: string]: string;
  }>({});
  const [placeholders, setPlaceholders] = useState<{ [key: string]: string }>(
    {}
  );
  const [showAddressPopup, setShowAddressPopup] = useState<boolean>(false);
  const [selectedInput, setSelectedInput] = useState<string | null>(null);

  const keyManager = KeyManager();
  const dispatch: AppDispatch = useDispatch();

  // Get the current walletId from the Redux store
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  // Fetch the ABI functions
  useEffect(() => {
    if (!contractABI || !Array.isArray(contractABI)) {
      console.error('Contract ABI is invalid or not an array');
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

  const handleFunctionSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedFunctionName = e.target.value;
    setSelectedFunctionState(selectedFunctionName);

    const functionAbi = functions.find(
      (item) => item.name === selectedFunctionName
    );
    setInputsState(functionAbi?.inputs || []);
    setInputValuesState({});
    setPlaceholders({});
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setInputValuesState((prev) => ({ ...prev, [name]: value }));
  };

  const handleSelect = () => {
    console.log('Selected function:', selectedFunction);
    console.log('Inputs:', inputs);
    console.log('Input values before dispatch:', inputValues);

    // Merge input values with placeholders to get the final input values object
    const inputValuesObject = inputs.reduce<{ [key: string]: string }>(
      (acc, input) => {
        // Map placeholders 'pubkey' to 'pk' and 'sig' to 's'
        if (input.name === 'pk') {
          acc[input.name] =
            inputValues[input.name] || placeholders['pubkey'] || '';
        } else if (input.name === 's') {
          acc[input.name] =
            inputValues[input.name] || placeholders['sig'] || '';
        } else {
          acc[input.name] = inputValues[input.name] || '';
        }
        return acc;
      },
      {}
    );

    console.log('Dispatching input values object:', inputValuesObject);

    try {
      dispatch(setSelectedFunction(selectedFunction));
      dispatch(setInputs(inputs)); // Ensure this is always an array
      dispatch(setInputValues(inputValuesObject));

      onFunctionSelect(selectedFunction, inputValuesObject);

      // Close the popup
      onClose();
    } catch (error) {
      console.error('Error occurred during dispatch or handling:', error);
    }
  };

  const fetchKeysForAddress = async (address: string) => {
    try {
      if (walletId === 0) {
        throw new Error('Invalid walletId');
      }

      const keys = await keyManager.retrieveKeys(walletId);
      const selectedKey = keys.find((key) => key.address === address);

      if (selectedKey) {
        const publicKeyHex = hexString(selectedKey.publicKey);
        const privateKeyWif = encodePrivateKeyWif(
          selectedKey.privateKey,
          'testnet'
        );

        console.log('Fetched publicKeyHex:', publicKeyHex);
        console.log('Fetched privateKeyWif:', privateKeyWif);

        setPlaceholders((prev) => {
          const updatedPlaceholders = { ...prev };
          if (selectedInput === 'pubkey') {
            updatedPlaceholders['pubkey'] = publicKeyHex;
          } else if (selectedInput === 'sig') {
            updatedPlaceholders['sig'] = privateKeyWif;
          }
          console.log(
            'Updated placeholders after fetching keys:',
            updatedPlaceholders
          );
          return updatedPlaceholders;
        });
      } else {
        console.error(`No keys found for address: ${address}`);
      }
    } catch (error) {
      console.error('Error fetching keys:', error);
    }
  };

  const handleAddressSelect = (address: string) => {
    console.log('Address clicked:', address);
    fetchKeysForAddress(address);
  };

  const openAddressPopup = (inputType: string) => {
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
          {Array.isArray(inputs) &&
            inputs.map((input, index) => (
              <div key={index} className="mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  {input.name} ({input.type})
                </label>
                <input
                  type="text"
                  name={input.name}
                  value={
                    inputValues[input.name] || placeholders[input.name] || ''
                  }
                  onChange={handleInputChange}
                  className="border p-2 w-full"
                  placeholder={
                    placeholders[input.name] || `Enter ${input.name}`
                  }
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
