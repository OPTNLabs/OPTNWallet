// src/components/SelectContractFunctionPopup.tsx

import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import AddressSelectionPopup from './AddressSelectionPopup';
import {
  setSelectedFunction,
  setInputs,
  setInputValues,
} from '../redux/contractSlice';
import { RootState, AppDispatch } from '../redux/store';
import { hexString } from '../utils/hex';
import KeyService from '../services/KeyService';
import { shortenTxHash } from '../utils/shortenHash';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { FaCamera } from 'react-icons/fa';
import { Toast } from '@capacitor/toast';
import { DataSigner } from '../utils/dataSigner';

interface AbiInput {
  name: string;
  type: string;
}

interface SelectContractFunctionPopupProps {
  currentContractSource: string;
  contractABI: any[];
  onClose: () => void;
  onFunctionSelect: (
    selectedFunction: string,
    inputValues: { [key: string]: string }
  ) => void;
}

const SelectContractFunctionPopup: React.FC<
  SelectContractFunctionPopupProps
> = ({ currentContractSource, contractABI, onClose, onFunctionSelect }) => {
  const [functions, setFunctions] = useState<any[]>([]);
  const [selectedFunction, setSelectedFunctionState] = useState<string>('');
  const [inputs, setInputsState] = useState<AbiInput[]>([]);
  const [inputValuesState, setInputValuesState] = useState<{
    [key: string]: string;
  }>({});
  const [showAddressPopup, setShowAddressPopup] = useState<boolean>(false);
  const [selectedInput, setSelectedInput] = useState<AbiInput | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [usesCheckDataSig, setUsesCheckDataSig] = useState<boolean>(false);
  const [messageInput, setMessageInput] = useState<{ [key: string]: string }>(
    {}
  );
  const [bytesParamName, setBytesParamName] = useState<string | null>(null);

  const dispatch: AppDispatch = useDispatch();
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  // Synchronize local inputValuesState with Redux's inputValues
  useEffect(() => {
    dispatch(setInputValues(inputValuesState));
  }, [inputValuesState, dispatch]);

  // Parse contract source to check for checkdatasig and identify bytes parameter
  useEffect(() => {
    if (selectedFunction && currentContractSource) {
      try {
        const functionRegex = new RegExp(
          `function\\s+${selectedFunction}\\s*\\(([^)]*)\\)\\s*{([\\s\\S]*?)}`,
          'i'
        );
        const match = currentContractSource.match(functionRegex);
        if (match && match[2]) {
          const functionBody = match[2];
          const hasCheckDataSig =
            /checkdatasig\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/i.test(
              functionBody
            );
          setUsesCheckDataSig(hasCheckDataSig);

          if (hasCheckDataSig) {
            const checkDataSigMatch = functionBody.match(
              /checkdatasig\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/i
            );
            if (checkDataSigMatch && checkDataSigMatch[2]) {
              setBytesParamName(checkDataSigMatch[2]); // The second argument is the message (bytes)
            } else {
              setBytesParamName(null);
            }
          } else {
            setBytesParamName(null);
          }
        } else {
          setUsesCheckDataSig(false);
          setBytesParamName(null);
        }
      } catch (error) {
        console.error('Error parsing contract source for checkdatasig:', error);
        setUsesCheckDataSig(false);
        setBytesParamName(null);
      }
    } else {
      setUsesCheckDataSig(false);
      setBytesParamName(null);
    }
  }, [selectedFunction, currentContractSource]);

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

  const allInputsFilled = inputs.every(
    (input) =>
      inputValuesState[input.name] && inputValuesState[input.name].trim() !== ''
  );

  const handleFunctionSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedFunctionName = e.target.value;
    setSelectedFunctionState(selectedFunctionName);

    const functionAbi = functions.find(
      (item) => item.name === selectedFunctionName
    );
    setInputsState(functionAbi?.inputs || []);
    setInputValuesState({});
    setMessageInput({});
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setInputValuesState((prev) => ({ ...prev, [name]: value }));
  };

  const generateMessage = async (argName: string) => {
    const data = messageInput[argName];
    if (!data) {
      await Toast.show({
        text: 'Please enter data to generate the message.',
      });
      return;
    }
    try {
      // Initialize DataSigner with a dummy private key (not used for createMessage)
      const signer = new DataSigner(new Uint8Array(32)); // Dummy key, as createMessage doesn't use it
      const message = signer.createMessage(data);
      const messageHex = Buffer.from(message).toString('hex');
      setInputValuesState((prev) => ({ ...prev, [argName]: messageHex }));
      await Toast.show({ text: 'Message generated successfully!' });
    } catch (error) {
      console.error('Error generating message:', error);
      await Toast.show({ text: 'Failed to generate message.' });
    }
  };

  const handleAddressSelect = async (address: string) => {
    try {
      if (!selectedInput) return;

      const keys = await KeyService.retrieveKeys(walletId);
      const selectedKey = keys.find((key) => key.address === address);

      if (selectedKey) {
        let valueToSet = '';
        if (selectedInput.type === 'pubkey') {
          valueToSet = hexString(selectedKey.publicKey);
        } else if (selectedInput.type === 'bytes20') {
          valueToSet = hexString(selectedKey.pubkeyHash);
        } else if (selectedInput.type === 'sig') {
          valueToSet = `sigaddr:${address}`;
        }
        setInputValuesState((prev) => ({
          ...prev,
          [selectedInput.name]: valueToSet,
        }));
      } else {
        console.error(`No keys found for address: ${address}`);
        await Toast.show({
          text: `No keys found for address: ${address}`,
        });
      }
    } catch (error) {
      console.error('Error fetching keys:', error);
      await Toast.show({
        text: 'Failed to fetch keys.',
      });
    }

    setShowAddressPopup(false);
    setSelectedInput(null);
  };

  const scanBarcode = async (argName: string, argType: string) => {
    if (isScanning) return;

    setIsScanning(true);
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });

      if (result && result.ScanResult) {
        const scannedValue = result.ScanResult.trim();
        const isValidHex = (str: string) => /^[0-9a-fA-F]+$/.test(str);

        const looksLikeCashaddr = (str: string) =>
          /^(bitcoincash:|bchtest:)?[0-9a-z]{20,}$/i.test(str);

        // If scanning a signature arg, interpret scanned address as sigaddr:<address>
        if (argType === 'sig') {
          const v = scannedValue.startsWith('sigaddr:')
            ? scannedValue
            : looksLikeCashaddr(scannedValue)
              ? `sigaddr:${scannedValue}`
              : scannedValue;
          setInputValuesState((prev) => ({ ...prev, [argName]: v }));
          return;
        }

        if (argType === 'pubkey' || argType === 'bytes20') {
          if (!isValidHex(scannedValue)) {
            await Toast.show({
              text: `Invalid ${argType} format. Please scan a valid QR code.`,
            });
          } else {
            setInputValuesState((prev) => ({
              ...prev,
              [argName]: scannedValue,
            }));
          }
        } else if (
          argType === 'bytes' &&
          argName === bytesParamName &&
          usesCheckDataSig
        ) {
          setMessageInput((prev) => ({ ...prev, [argName]: scannedValue }));
        } else {
          setInputValuesState((prev) => ({
            ...prev,
            [argName]: scannedValue,
          }));
        }
      } else {
        await Toast.show({
          text: 'No QR code detected. Please try again.',
        });
      }
    } catch (error) {
      console.error('Barcode scan error:', error);
      await Toast.show({
        text: 'Failed to scan QR code. Please ensure camera permissions are granted and try again.',
      });
    } finally {
      setShowAddressPopup(false);
      setSelectedInput(null);
      setIsScanning(false);
    }
  };

  const handleSelect = () => {
    const inputValuesObject = inputs.reduce<{ [key: string]: string }>(
      (acc, input) => {
        acc[input.name] = inputValuesState[input.name] || '';
        return acc;
      },
      {}
    );

    try {
      dispatch(setSelectedFunction(selectedFunction));
      dispatch(setInputs(inputs));
      onFunctionSelect(selectedFunction, inputValuesObject);
      onClose();
    } catch (error) {
      console.error('Error occurred during dispatch or handling:', error);
    }
  };

  const openAddressPopup = (input: AbiInput) => {
    setSelectedInput(input);
    setShowAddressPopup(true);
  };

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded shadow-lg w-96 max-h-screen overflow-y-auto">
        <h2 className="text-xl font-semibold mb-4">Select a Function</h2>
        <select
          className="border p-2 w-full mb-4 rounded-md"
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
            inputs.map((input, index) => {
              const isAddressType =
                input.type === 'sig' || input.type === 'pubkey';

              if (
                input.type === 'bytes' &&
                input.name === bytesParamName &&
                usesCheckDataSig
              ) {
                return (
                  <div key={index} className="mb-4">
                    <label className="block text-sm font-bold text-gray-700 mb-1">
                      {input.name} (message for checkdatasig)
                    </label>
                    <input
                      type="text"
                      name={`${input.name}_message`}
                      value={messageInput[input.name] || ''}
                      onChange={(e) =>
                        setMessageInput({
                          ...messageInput,
                          [input.name]: e.target.value,
                        })
                      }
                      className="border p-2 w-full rounded-md mb-2"
                      placeholder={`Enter message for ${input.name}`}
                    />
                    {/* <div className="flex items-center mb-2">
                      <button
                        type="button"
                        onClick={() => scanBarcode(input.name, input.type)}
                        className={`w-12 h-12 bg-green-500 hover:bg-green-600 font-bold text-white rounded flex items-center justify-center ${
                          isScanning ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                        disabled={isScanning}
                        aria-label={`Scan QR Code for ${input.name}`}
                      >
                        <FaCamera className="text-lg" />
                      </button>
                    </div> */}
                    <button
                      type="button"
                      onClick={() => generateMessage(input.name)}
                      className={`bg-green-500 hover:bg-green-600 text-white font-bold py-2 px-4 rounded ${
                        !messageInput[input.name]
                          ? 'opacity-50 cursor-not-allowed'
                          : ''
                      }`}
                      disabled={!messageInput[input.name]}
                    >
                      Generate Message
                    </button>
                    {inputValuesState[input.name] && (
                      <div className="mt-2 text-sm text-gray-600">
                        Message: {shortenTxHash(inputValuesState[input.name])}
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <div key={index} className="mb-4">
                  <label className="block text-sm font-bold text-gray-700 mb-1">
                    {input.name} ({input.type})
                  </label>
                  {isAddressType ? (
                    <>
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => openAddressPopup(input)}
                          className="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded min-w-fit mr-2"
                          disabled={isScanning}
                          aria-label={`Select Address for ${input.name}`}
                        >
                          Select Address
                        </button>
                        <button
                          type="button"
                          onClick={() => scanBarcode(input.name, input.type)}
                          className={`w-12 h-12 bg-green-500 hover:bg-green-600 font-bold text-white rounded flex items-center justify-center ${
                            isScanning ? 'opacity-50 cursor-not-allowed' : ''
                          }`}
                          disabled={isScanning}
                          aria-label={`Scan QR Code for ${input.name}`}
                        >
                          <FaCamera className="text-lg" />
                        </button>
                      </div>
                      {inputValuesState[input.name] && (
                        <div className="mt-2 text-sm text-gray-600">
                          Selected {input.type}:{' '}
                          {shortenTxHash(inputValuesState[input.name])}
                        </div>
                      )}
                    </>
                  ) : (
                    <input
                      type="text"
                      name={input.name}
                      value={inputValuesState[input.name] || ''}
                      onChange={handleInputChange}
                      className="border p-2 w-full rounded-md"
                      placeholder={`Enter ${input.name}`}
                    />
                  )}
                </div>
              );
            })}
        </div>
        <div className="flex justify-end">
          <button
            className={`font-bold text-white py-2 px-4 rounded mr-2 ${
              !selectedFunction || !allInputsFilled
                ? 'bg-gray-500 cursor-not-allowed'
                : 'bg-green-500 hover:bg-green-600'
            }`}
            onClick={handleSelect}
            disabled={!selectedFunction || !allInputsFilled}
          >
            Select
          </button>
          <button
            className="bg-red-500 hover:bg-red-600 font-bold text-white py-2 px-4 rounded"
            onClick={onClose}
          >
            Back
          </button>
        </div>
        {showAddressPopup && selectedInput && (
          <AddressSelectionPopup
            onSelect={handleAddressSelect}
            onClose={() => {
              setShowAddressPopup(false);
              setSelectedInput(null);
            }}
          />
        )}
      </div>
    </div>
  );
};

export default SelectContractFunctionPopup;
