import React, { useState } from 'react';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import { FaCamera } from 'react-icons/fa';
import { TransactionOutput, UTXO } from '../../types/types';
import { shortenTxHash } from '../../utils/shortenHash';
import { Network } from '../../redux/networkSlice';
import { PREFIX, DUST } from '../../utils/constants';
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
  utxos: UTXO[];
  selectedUtxos: UTXO[];
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
  selectedUtxos,
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
  console.warn(
    `Unused Params: ${showOutputs}, ${setShowOutputs}, ${closePopups}`
  );
  const dispatch: AppDispatch = useDispatch();

  // OP_RETURN state
  const [showOpReturn, setShowOpReturn] = useState<boolean>(false);
  const [opReturnText, setOpReturnText] = useState<string>('');

  // CashToken creation state
  const [showCashToken, setShowCashToken] = useState<boolean>(false);

  // Prepare the OP_RETURN text into an array of strings
  const opReturnArray = opReturnText
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Local popup
  const [showPopup, setShowPopup] = useState<boolean>(false);

  // Extract unique token categories from UTXOs
  const availableTokenCategories = [
    ...new Set(
      utxos.filter((utxo) => utxo.token).map((utxo) => utxo.token!.category)
    ),
  ];

  // Toggle popup
  const togglePopup = () => {
    setShowPopup((prev) => !prev);
  };

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

  // Barcode scanning
  const scanBarcode = async () => {
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
      });
      if (result && result.ScanResult) {
        setRecipientAddress(result.ScanResult);
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

  // Handle adding an output with validation
  const handleAddOutput = async () => {
    if (transferAmount < DUST) {
      await Toast.show({
        text: `Transfer amount must be at least ${DUST}.`,
      });
      return;
    }
    // Later, you can incorporate opReturnText or token data
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
            <h3 className="text-lg font-semibold">{`${txOutputs.length} Recipient${
              txOutputs.length === 1 ? '' : 's'
            } - Total: ${txOutputs.reduce(
              (sum, utxo) => sum + Number(utxo.amount),
              0
            )}`}</h3>
          </div>
        )}

        {/* Add Output Section */}
        {txOutputs.length < 10 && (
          <div className="mb-6">
            <h3 className="text-lg font-semibold mb-2">Add Output</h3>

            {/* Button row for toggling OP_RETURN or CashToken creation */}
            <div className="mb-2 flex justify-between items-center">
              <button
                onClick={() => {
                  // Optionally hide the other panel if it’s open
                  setShowCashToken(false);
                  setShowOpReturn((prev) => !prev);
                }}
                className="bg-purple-500 font-bold text-white py-1 px-2 rounded"
              >
                {showOpReturn ? 'Hide OP_RETURN' : 'Show OP_RETURN'}
              </button>

              <button
                onClick={() => {
                  // Optionally hide the other panel if it’s open
                  setShowOpReturn(false);
                  setShowCashToken((prev) => !prev);
                }}
                className="bg-orange-500 font-bold text-white py-1 px-2 rounded"
              >
                Create CashToken
              </button>
            </div>

            {/* If neither toggle is active, show normal inputs */}
            {!showOpReturn && !showCashToken && (
              <>
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

                {/* Token Amount Input */}
                <div className="mb-2">
                  <input
                    type="number"
                    value={tokenAmount}
                    placeholder="Token Amount"
                    onChange={handleTokenAmountChange}
                    className="border p-2 w-full break-words whitespace-normal"
                  />
                </div>

                {/* Token Category Dropdown (optional) */}
                {availableTokenCategories.length > 0 && (
                  <div className="mb-2">
                    <select
                      value={selectedTokenCategory}
                      onChange={(e) => setSelectedTokenCategory(e.target.value)}
                      className="border p-2 w-full break-words whitespace-normal"
                    >
                      <option value="">Select Token Category</option>
                      {availableTokenCategories.map(
                        (category: string, index) => (
                          <option key={index} value={category}>
                            {category}
                          </option>
                        )
                      )}
                    </select>
                  </div>
                )}
              </>
            )}

            {/* OP_RETURN section */}
            {showOpReturn && (
              <>
                <div className="mb-2">
                  <input
                    type="text"
                    value={opReturnText}
                    placeholder="OP_RETURN Text"
                    onChange={(e) => setOpReturnText(e.target.value)}
                    className="border p-2 w-full break-words whitespace-normal"
                  />
                </div>
                <div className="mb-2">
                  <label className="font-medium block mb-1">
                    Prepared OP_RETURN Data:
                  </label>
                  <pre className="bg-gray-100 p-2 rounded text-sm">
                    {JSON.stringify(opReturnArray, null, 2)}
                  </pre>
                </div>
              </>
            )}

            {/* Create CashToken section */}
            {showCashToken && (
              <>
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

                <div className="mb-2">
                  <input
                    type="number"
                    value={tokenAmount}
                    placeholder="Token Amount"
                    onChange={handleTokenAmountChange}
                    className="border p-2 w-full break-words whitespace-normal"
                  />
                </div>

                <div className="mb-2">
                  <select
                    value={selectedTokenCategory}
                    onChange={(e) => setSelectedTokenCategory(e.target.value)}
                    className="border p-2 w-full break-words whitespace-normal"
                  >
                    <option value="">
                      Select a UTXO to use for creating CashToken
                    </option>

                    {selectedUtxos
                      .filter((utxo) => !utxo.token) // Only UTXOs without token
                      .map((utxo, index) => (
                        <option key={utxo.tx_hash + index} value={utxo.tx_hash}>
                          {utxo.tx_hash}
                        </option>
                      ))}
                  </select>
                </div>
              </>
            )}

            {/* Add Output Button */}
            <button
              onClick={handleAddOutput}
              className="bg-blue-500 font-bold text-white py-2 px-4 rounded"
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
