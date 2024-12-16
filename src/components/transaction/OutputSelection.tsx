// @ts-nocheck
// src/components/transaction/OutputSelection.tsx

import React from 'react';
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import { FaCamera } from 'react-icons/fa';
import { TransactionOutput } from '../../types/types'; // Adjust the path based on your project structure
import { shortenTxHash } from '../../utils/shortenHash';
import { Network } from '../../redux/networkSlice';
import { PREFIX, DUST } from '../../utils/constants'; // Import DUST

interface OutputSelectionProps {
  recipientAddress: string;
  setRecipientAddress: (address: string) => void;
  currentNetwork: Network;
  transferAmount: number;
  setTransferAmount: (amount: number) => void;
  tokenAmount: number;
  setTokenAmount: (amount: number) => void;
  utxos: any[]; // Replace `any` with the appropriate UTXO type
  selectedTokenCategory: string;
  setSelectedTokenCategory: (category: string) => void;
  addOutput: () => void;
  changeAddress: string;
  setChangeAddress: (address: string) => void;
  txOutputs: TransactionOutput[];
  handleRemoveOutput: (index: number) => void;
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
}) => {
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

  // Function to initiate barcode scanning
  const scanBarcode = async () => {
    try {
      // Check and request camera permission
      const permission = await CapacitorBarcodeScanner.checkPermission({ force: true });
      if (permission.granted) {
        // Initiate barcode scanning with desired options
        const result = await CapacitorBarcodeScanner.scanBarcode({
          hint: CapacitorBarcodeScannerTypeHint.ALL,
        });

        // If a scan result is obtained, set it as the recipient address
        if (result && result.ScanResult) {
          setRecipientAddress(result.ScanResult);
        }
      } else {
        alert('Camera permission is required to scan QR codes.');
      }
    } catch (error) {
      console.error('Barcode scan error:', error);
      alert('Failed to scan barcode. Please try again.');
    }
  };

  // Function to handle adding an output with validation
  const handleAddOutput = async () => {
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
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">Transaction Outputs</h3>
        {txOutputs.length === 0 ? (
          <p className="text-gray-500">No outputs added yet.</p>
        ) : (
          txOutputs.map((output, index) => (
            <div
              key={index}
              className="flex flex-col items-start mb-4 p-4 border rounded w-full break-words whitespace-normal bg-gray-50"
            >
              <div className="flex justify-between w-full">
                <span className="font-medium">Recipient:</span>
                <span>{shortenTxHash(output.recipientAddress, PREFIX[currentNetwork].length)}</span>
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
                onClick={() => handleRemoveOutput(index)}
                className="mt-2 text-red-500 hover:underline"
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      {/* Add Output Section */}
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
          className={`bg-blue-500 text-white py-2 px-4 rounded`}
          // disabled={transferAmount < DUST}
        >
          Add Output
        </button>
      </div>

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
    </>
  );
};

export default OutputSelection;
