// @ts-nocheck
// src/components/transaction/OutputSelection.tsx

import React, { useState } from 'react';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import { FaCamera } from 'react-icons/fa';
import { TransactionOutput, UTXO } from '../../types/types'; // Ensure UTXO type is defined
import { shortenTxHash } from '../../utils/shortenHash';
import { Network } from '../../redux/networkSlice';
import { PREFIX, DUST } from '../../utils/constants'; // Import DUST
import Popup from './Popup';
import { AppDispatch } from '../../redux/store';
import { useDispatch } from 'react-redux';
import { clearTransaction } from '../../redux/transactionBuilderSlice';

interface OutputSelectionProps {
  recipientAddress: string;
  setRecipientAddress: (address: string) => void;
  currentNetwork: Network;
  transferAmount: number;
  setTransferAmount: (amount: number) => void;
  tokenAmount: number;
  setTokenAmount: (amount: number) => void;
  utxos: UTXO[]; // Replaced `any` with `UTXO`
  selectedTokenCategory: string;
  setSelectedTokenCategory: (category: string) => void;
  addOutput: () => void;
  changeAddress: string;
  setChangeAddress: (address: string) => void;
  txOutputs: TransactionOutput[];
  handleRemoveOutput: (index: number) => void;
  showOutputs: boolean;
  setShowOutputs: React.Dispatch<React.SetStateAction<boolean>>;
  closePopups: () => void;
}

const OutputSelection: React.FC<OutputSelectionProps> = ({
  recipientAddress,
  setRecipientAddress,
  currentNetwork,
  transferAmount,
  setTransferAmount,
  tokenAmount,
  setTokenAmount,
  utxos,
  selectedTokenCategory,
  setSelectedTokenCategory,
  addOutput,
  changeAddress,
  setChangeAddress,
  txOutputs,
  handleRemoveOutput,
  showOutputs,
  setShowOutputs,
  closePopups,
}) => {
  const [showPopup, setShowPopup] = useState<boolean>(false); // Local state for popup visibility
  const dispatch: AppDispatch = useDispatch();

  // Function to toggle the popup
  const togglePopup = () => {
    setShowPopup((prev) => !prev);
  };

  // Extract unique token categories from UTXOs
  const availableTokenCategories = [
    ...new Set(
      utxos
        .filter((utxo) => utxo.token_data)
        .map((utxo) => utxo.token_data!.category)
    ),
  ];

  // Handle changes to the regular transfer amount input
  const handleTransferAmountChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const value = e.target.value;
    const numValue = Number(value);

    if (value === '') {
      setTransferAmount(0);
    } else {
      setTransferAmount(numValue);
    }
  };

  // Handle changes to the token amount input
  const handleTokenAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setTokenAmount(value === '' ? 0 : Number(value));
  };

  // // Function to check and request camera permissions
  // const checkAndRequestPermissions = async (): Promise<boolean> => {
  //   const permission = await CapacitorBarcodeScanner.checkPermission({
  //     force: true,
  //   });
  //   if (permission.granted) {
  //     return true;
  //   } else {
  //     await Toast.show({
  //       text: 'Camera permission is required to scan QR codes.',
  //     });
  //     return false;
  //   }
  // };

  // Function to initiate barcode scanning
  const scanBarcode = async () => {
    // const hasPermission = true; //await checkAndRequestPermissions();
    // if (!hasPermission) {
    //   return;
    // }

    try {
      // Initiate barcode scanning with desired options
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
      });

      // If a scan result is obtained, set it as the recipient address
      if (result && result.ScanResult) {
        setRecipientAddress(result.ScanResult);
        // await Toast.show({
        //   text: `Scanned: ${result.ScanResult}`,
        // });
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
    }
  };

  // Function to handle adding an output with validation
  const handleAddOutput = async () => {
    // await Toast.show({
    //   text: `Change Address: ${changeAddress}`,
    // });
    if (transferAmount < DUST) {
      await Toast.show({
        text: `Transfer amount must be at least ${DUST}.`,
      });
      return;
    }
    addOutput();
  };

  return (
    <>
      {/* Transaction Outputs Display Section */}
      <div className="mb-4">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold mb-2">Transaction Outputs</h3>
          {txOutputs.length > 0 && (
            <button
              onClick={togglePopup}
              className="bg-blue-500 font-bold text-white py-1 px-2 rounded hover:bg-blue-600 transition-colors duration-200"
            >
              Show
            </button>
          )}
        </div>

        {showPopup && (
          <Popup closePopups={() => setShowPopup(false)}>
            {txOutputs.length === 0 ? (
              <p className="text-gray-500">No outputs added yet.</p>
            ) : (
              <div className="max-h-[50vh] overflow-y-auto">
                {txOutputs.map((output, index) => (
                  <div
                    key={index}
                    className="flex flex-col items-start mb-4 p-4 border rounded w-full break-words whitespace-normal bg-gray-50"
                  >
                    <div className="flex justify-between w-full">
                      <span className="font-medium">Recipient:</span>
                      <span>
                        {shortenTxHash(
                          output.recipientAddress,
                          PREFIX[currentNetwork].length
                        )}
                      </span>
                    </div>
                    <div className="flex justify-between w-full">
                      <span className="font-medium">Amount:</span>
                      <span>{output.amount.toString()}</span>
                    </div>
                    {output.token && (
                      <>
                        <div className="flex justify-between w-full">
                          <span className="font-medium">Token:</span>
                          <span>{output.token.amount.toString()}</span>
                        </div>
                        <div className="flex justify-between w-full">
                          <span className="font-medium">Category:</span>
                          <span>{output.token.category}</span>
                        </div>
                      </>
                    )}
                    <button
                      onClick={() => {
                        handleRemoveOutput(index);
                        // console.log(txOutputs);
                        if (txOutputs.length === 1) togglePopup();
                      }}
                      className="bg-red-400 font-bold text-white py-1 px-2 rounded-md hover:bg-red-600 transition duration-300"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-center mt-4">
              <button
                onClick={() => {
                  dispatch(clearTransaction());
                  togglePopup();
                }}
                className="bg-red-400 font-bold text-white py-1 px-2 rounded-md hover:bg-red-600 transition duration-300"
              >
                Remove All
              </button>
            </div>
          </Popup>
        )}
        {txOutputs.length > 0 && (
          <div className="mb-4">
            <h3 className="text-lg font-semibold">{`${txOutputs.length} Recipient${txOutputs.length === 1 ? `` : `s`} - Total: ${txOutputs.reduce(
              (sum, utxo) => sum + Number(utxo.amount),
              0
            )}`}</h3>
          </div>
        )}

        {/* Add Output Section */}
        {txOutputs.length < 10 && (
          <div className="mb-6">
            <h3 className="text-lg font-semibold mb-2">Add Output</h3>

            {/* Recipient Address Input with Scan Button */}
            <div className="flex items-center mb-2">
              <input
                type="text"
                value={recipientAddress}
                placeholder="Recipient Address"
                onChange={(e) => setRecipientAddress(e.target.value)}
                className="border p-2 w-full break-words whitespace-normal"
              />
              <button
                onClick={scanBarcode}
                className="ml-2 bg-green-500 text-white p-2 rounded"
                title="Scan QR Code"
              >
                <FaCamera />
              </button>
            </div>

            {/* Regular Transfer Amount Input */}
            <div className="mb-2">
              <input
                type="number"
                value={transferAmount}
                placeholder={`Regular Amount (Min: ${DUST})`}
                onChange={handleTransferAmountChange}
                className="border p-2 w-full break-words whitespace-normal"
                min={DUST}
              />
            </div>

            {/* Uncomment the following section if you want to include token amount and category selection */}
            {/*
        <div className="mb-2">
          <input
            type="number"
            value={tokenAmount}
            placeholder="Token Amount"
            onChange={handleTokenAmountChange}
            className="border p-2 w-full break-words whitespace-normal"
          />
        </div>
        {availableTokenCategories.length > 0 && (
          <div className="mb-2">
            <select
              value={selectedTokenCategory}
              onChange={(e) => setSelectedTokenCategory(e.target.value)}
              className="border p-2 w-full break-words whitespace-normal"
            >
              <option value="">Select Token Category</option>
              {availableTokenCategories.map((category: string, index) => (
                <option key={index} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
        )}
        */}

            {/* Add Output Button */}
            <button
              onClick={handleAddOutput}
              className={`bg-blue-500 font-bold text-white py-2 px-4 rounded`}
            >
              Add Output
            </button>
          </div>
        )}

        {/* Change Address Section */}
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-2">Change Address</h3>
          <input
            type="text"
            value={changeAddress}
            placeholder="Change Address"
            onChange={(e) => setChangeAddress(e.target.value)}
            className="border p-2 mb-2 w-full break-words whitespace-normal"
          />
        </div>
      </div>
    </>
  );
};

export default OutputSelection;
