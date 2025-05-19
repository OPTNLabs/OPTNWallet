// @ts-nocheck
// src/components/transaction/OutputSelection.tsx

import React, { useState, useEffect } from 'react';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import { FaCamera } from 'react-icons/fa';
import { IdentitySnapshot } from '@bitauth/libauth';
import BcmrService from '../../services/BcmrService';
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

  // NFT
  nftCapability: 'none' | 'mutable' | 'minting';
  setNftCapability: (value: 'none' | 'mutable' | 'minting') => void;
  nftCommitment: string;
  setNftCommitment: (value: string) => void;
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

  nftCapability,
  setNftCapability,
  nftCommitment,
  setNftCommitment,
}) => {
  const dispatch: AppDispatch = useDispatch();

  // Popup states
  const [showPopup, setShowPopup] = useState<boolean>(false);
  const [showAddOutputPopup, setShowAddOutputPopup] = useState<boolean>(false);

  // Toggling among the three "views"
  const [showRegularTx, setShowRegularTx] = useState<boolean>(false);
  const [showCashToken, setShowCashToken] = useState<boolean>(false);
  const [showNFTCashToken, setShowNFTCashToken] = useState<boolean>(false);

  // Title label for the main "Add Output" popup
  const [popupTitle, setPopupTitle] = useState<string>('Add Output');

  // Additional sub-popup for NFT config
  const [showNFTConfigPopup, setShowNFTConfigPopup] = useState<boolean>(false);

  // OP_RETURN toggles
  const [showOpReturn, setShowOpReturn] = useState<boolean>(false);
  const [opReturnText, setOpReturnText] = useState<string>('');
  const opReturnArray = opReturnText
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Identify "genesis-capable" UTXOs among the user's selection
  const hasGenesisUtxoSelected = selectedUtxos.some(
    (utxo) => !utxo.token && utxo.tx_pos === 0
  );

  // Only show token categories for the user’s currently selected token-based UTXOs
  const selectedTokenUtxos = selectedUtxos.filter((u) => u.token);
  const categoriesFromSelected = [
    ...new Set(selectedTokenUtxos.map((u) => u.token.category)),
  ];

  // <categoryHex> → { name: string, iconUri: string | null }
  const [tokenMetadata, setTokenMetadata] = useState<
    Record<string, { name: string; iconUri: string | null }>
  >({});

  // Whenever the set of categories changes, fetch any missing metadata
  useEffect(() => {
    const svc = new BcmrService();
    (async () => {
      const newMeta: Record<string, { name: string; iconUri: string | null }> =
        {};
      for (const category of categoriesFromSelected) {
        if (!tokenMetadata[category]) {
          const authbase = await svc.getCategoryAuthbase(category);
          const idReg = await svc.resolveIdentityRegistry(authbase);
          const snap: IdentitySnapshot = svc.extractIdentity(
            authbase,
            idReg.registry
          );
          const iconUri = await svc.resolveIcon(authbase);
          newMeta[category] = { name: snap.name, iconUri };
        }
      }
      if (Object.keys(newMeta).length > 0) {
        setTokenMetadata((prev) => ({ ...prev, ...newMeta }));
      }
    })();
  }, [categoriesFromSelected]);

  // If user toggles "Create NFT," default tokenAmount to 0
  useEffect(() => {
    if (showNFTCashToken) {
      setTokenAmount(0);
    }
  }, [showNFTCashToken, setTokenAmount]);

  /** Resets form toggles/fields */
  const resetFormValues = () => {
    setShowRegularTx(false);
    setShowCashToken(false);
    setShowNFTCashToken(false);
    setShowOpReturn(false);
    setShowNFTConfigPopup(false);
    setPopupTitle('Add Output');

    setRecipientAddress('');
    setTransferAmount(0);
    setTokenAmount(0);
    setSelectedTokenCategory('');
    setNftCapability('none');
    setNftCommitment('');
    setOpReturnText('');
  };

  const togglePopup = () => {
    setShowPopup((prev) => !prev);
  };

  // Input change handlers
  const handleTransferAmountChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const value = e.target.value;
    setTransferAmount(value === '' ? 0 : Number(value));
  };

  const handleTokenAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // If in NFT creation, we do not allow editing tokenAmount
    if (showNFTCashToken) return;
    const value = e.target.value;
    setTokenAmount(value === '' ? 0 : Number(value));
  };

  // QR code scanning
  const scanBarcode = async () => {
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
      });
      if (result && result.ScanResult) {
        setRecipientAddress(result.ScanResult);
      } else {
        await Toast.show({ text: 'No QR code detected. Please try again.' });
      }
    } catch (error) {
      console.error('Barcode scan error:', error);
      await Toast.show({
        text: 'Failed to scan QR code. Please ensure camera permissions are granted and try again.',
      });
    }
  };

  // Validate & add output
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
      <div className="mb-4">
        {/* Transaction Outputs Section */}
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

        {/* Popup with existing outputs */}
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
                    {/* Recipient */}
                    <div className="flex justify-between w-full">
                      <span className="font-medium">Recipient:</span>
                      <span>
                        {shortenTxHash(
                          output.recipientAddress,
                          PREFIX[currentNetwork].length
                        )}
                      </span>
                    </div>
                    {/* Amount */}
                    <div className="flex justify-between w-full">
                      <span className="font-medium">Amount:</span>
                      <span>{output.amount.toString()}</span>
                    </div>
                    {/* Token */}
                    {output.token && (
                      <>
                        <div className="flex justify-between w-full">
                          <span className="font-medium">Token:</span>
                          <span>
                            {output.token.amount
                              ? output.token.amount.toString()
                              : 'NFT'}
                          </span>
                        </div>
                        <div className="flex justify-between w-full">
                          <span className="font-medium">Category:</span>
                          <span>{output.token.category}</span>
                        </div>
                        {/* NFT */}
                        {output.token.nft && (
                          <>
                            <div className="flex justify-between w-full">
                              <span className="font-medium">Capability:</span>
                              <span>{output.token.nft.capability}</span>
                            </div>
                            <div className="flex justify-between w-full">
                              <span className="font-medium">Commitment:</span>
                              <span>{output.token.nft.commitment}</span>
                            </div>
                          </>
                        )}
                      </>
                    )}
                    {/* Remove Output button */}
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
            {/* Remove All */}
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

        {/* Summary of existing outputs */}
        {txOutputs.length > 0 && (
          <div className="mb-4">
            <h3 className="text-lg font-semibold">
              {`${txOutputs.length} Recipient${txOutputs.length === 1 ? '' : 's'} - Total: ${txOutputs.reduce(
                (sum, utxo) => sum + Number(utxo.amount),
                0
              )}`}
            </h3>
          </div>
        )}

        {/* "Add Output" Button */}
        {txOutputs.length < 10 && (
          <div className="mb-6">
            <button
              onClick={() => {
                resetFormValues();
                // default to "Send Regular Transaction"
                setShowRegularTx(true);
                setPopupTitle('Send Regular Transaction');
                setShowAddOutputPopup(true);
              }}
              className="bg-blue-500 font-bold text-white py-2 px-4 rounded"
            >
              Add Output
            </button>
          </div>
        )}

        {/* "Add Output" Popup */}
        {showAddOutputPopup && (
          <Popup closePopups={() => setShowAddOutputPopup(false)}>
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-2">{popupTitle}</h3>

              <div className="mb-2 flex flex-wrap gap-2">
                {/* Send Regular Transaction */}
                {/* <button
                  onClick={() => {
                    resetFormValues();
                    setShowRegularTx(true);
                    setPopupTitle('Send Regular Transaction');
                  }}
                  className={`font-bold py-1 px-2 rounded ${
                    showRegularTx
                      ? 'bg-blue-600 text-white'
                      : 'bg-blue-200 text-gray-800'
                  }`}
                >
                  Send Regular Transaction
                </button> */}

                {hasGenesisUtxoSelected && (
                  <>
                    {/* Create CashToken */}
                    <button
                      onClick={() => {
                        resetFormValues();
                        setShowCashToken(true);
                        setPopupTitle('Create CashToken');
                      }}
                      className={`font-bold py-1 px-2 rounded ${
                        showCashToken
                          ? 'bg-orange-500 text-white'
                          : 'bg-orange-200 text-gray-800'
                      } hover:bg-orange-600`}
                    >
                      Create CashToken
                    </button>

                    {/* Create NFT */}
                    <button
                      onClick={() => {
                        resetFormValues();
                        setShowNFTCashToken(true);
                        setPopupTitle('Create NFT');
                      }}
                      className={`font-bold py-1 px-2 rounded ${
                        showNFTCashToken
                          ? 'bg-pink-500 text-white'
                          : 'bg-pink-200 text-gray-800'
                      } hover:bg-pink-600`}
                    >
                      Create NFT
                    </button>
                  </>
                )}
              </div>

              {/* Regular TX view */}
              {showRegularTx && (
                <>
                  <div className="mb-2">
                    <label className="block font-medium mb-1">
                      Recipient Address
                    </label>
                    <div className="flex items-center">
                      <input
                        type="text"
                        value={recipientAddress}
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
                  </div>

                  <div className="mb-2">
                    <label className="block font-medium mb-1">
                      Transfer Amount (Sats)
                    </label>
                    <input
                      type="number"
                      value={transferAmount}
                      onChange={handleTransferAmountChange}
                      className="border p-2 w-full break-words whitespace-normal"
                      min={DUST}
                    />
                  </div>

                  {/* If user has token-based UTXOs selected, show token fields */}
                  {categoriesFromSelected.length > 0 && (
                    <>
                      <div className="mb-2">
                        <label className="block font-medium mb-1">
                          Token Amount
                        </label>
                        <input
                          type="number"
                          value={tokenAmount}
                          onChange={handleTokenAmountChange}
                          className="border p-2 w-full break-words whitespace-normal"
                        />
                      </div>

                      <div className="mb-2">
                        <label className="block font-medium mb-1">
                          Token Category
                        </label>
                        <select
                          value={selectedTokenCategory}
                          onChange={(e) =>
                            setSelectedTokenCategory(e.target.value)
                          }
                          className="border p-2 w-full break-words whitespace-normal"
                        >
                          <option value="">Select Cashtoken UTXO</option>
                          {categoriesFromSelected.map((category) => {
                            const meta = tokenMetadata[category];
                            return (
                              <option key={category} value={category}>
                                {meta?.name ?? shortenTxHash(category)}
                              </option>
                            );
                          })}
                        </select>
                        {/* ↓ preview of name & icon for the selected one */}
                        {selectedTokenCategory &&
                          tokenMetadata[selectedTokenCategory] &&
                          (() => {
                            const meta = tokenMetadata[selectedTokenCategory];
                            // find an example UTXO for this category to inspect nft
                            const example = selectedUtxos.find(
                              (u) => u.token?.category === selectedTokenCategory
                            );
                            const isNft = !!example?.token?.nft;
                            return (
                              <div className="flex justify-between items-center mt-2">
                                <div className="flex items-center">
                                  {meta.iconUri && (
                                    <img
                                      src={meta.iconUri}
                                      alt={meta.name}
                                      className="w-6 h-6 rounded mr-2"
                                    />
                                  )}
                                  <span className="font-medium">
                                    {meta.name}
                                  </span>
                                </div>
                                <span className="text-sm font-medium">
                                  {isNft ? 'NFT' : 'FT'}
                                </span>
                              </div>
                            );
                          })()}
                      </div>
                    </>
                  )}

                  {/* Right-aligned "Add Output" button for non-NFT flows */}
                  <div className="flex justify-end mt-4">
                    <button
                      onClick={handleAddOutput}
                      className="bg-blue-500 font-bold text-white py-2 px-4 rounded"
                    >
                      Add Output
                    </button>
                  </div>
                </>
              )}

              {/* Create CashToken */}
              {showCashToken && (
                <>
                  <label className="block font-medium mb-1">
                    Recipient Address
                  </label>
                  <div className="flex items-center mb-2">
                    <input
                      type="text"
                      value={recipientAddress}
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
                    <label className="block font-medium mb-1">
                      Transfer Amount (Sats)
                    </label>
                    <input
                      type="number"
                      value={transferAmount}
                      onChange={handleTransferAmountChange}
                      className="border p-2 w-full break-words whitespace-normal"
                      min={DUST}
                    />
                  </div>

                  <div className="mb-2">
                    <label className="block font-medium mb-1">
                      Token Amount
                    </label>
                    <input
                      type="number"
                      value={tokenAmount}
                      onChange={handleTokenAmountChange}
                      className="border p-2 w-full break-words whitespace-normal"
                    />
                  </div>

                  <div className="mb-2">
                    <label className="block font-medium mb-1">
                      Genesis UTXO for new Token
                    </label>
                    <select
                      value={selectedTokenCategory}
                      onChange={(e) => setSelectedTokenCategory(e.target.value)}
                      className="border p-2 w-full break-words whitespace-normal"
                    >
                      <option value="">Select Genesis UTXO</option>
                      {selectedUtxos
                        .filter((utxo) => !utxo.token && utxo.tx_pos === 0)
                        .map((utxo, index) => (
                          <option
                            key={utxo.tx_hash + index}
                            value={utxo.tx_hash}
                          >
                            {utxo.tx_hash}
                          </option>
                        ))}
                    </select>
                  </div>

                  {/* Right-aligned "Add Output" button for non-NFT flows */}
                  <div className="flex justify-end mt-4">
                    <button
                      onClick={handleAddOutput}
                      className="bg-blue-500 font-bold text-white py-2 px-4 rounded"
                    >
                      Add Output
                    </button>
                  </div>
                </>
              )}

              {/* Create NFT */}
              {showNFTCashToken && (
                <>
                  <label className="block font-medium mb-1">
                    Recipient Address
                  </label>
                  <div className="flex items-center mb-2">
                    <input
                      type="text"
                      value={recipientAddress}
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
                    <label className="block font-medium mb-1">
                      Transfer Amount (Sats)
                    </label>
                    <input
                      type="number"
                      value={transferAmount}
                      onChange={handleTransferAmountChange}
                      className="border p-2 w-full break-words whitespace-normal"
                      min={DUST}
                    />
                  </div>

                  <div className="mb-2">
                    <label className="block font-medium mb-1">
                      NFT Token Amount
                    </label>
                    {/* default to 0, user can't change */}
                    <input
                      type="number"
                      value={tokenAmount}
                      onChange={handleTokenAmountChange}
                      className="border p-2 w-full break-words whitespace-normal"
                      disabled
                    />
                  </div>

                  <div className="mb-2">
                    <label className="block font-medium mb-1">
                      Genesis UTXO for new NFT
                    </label>
                    <select
                      value={selectedTokenCategory}
                      onChange={(e) => setSelectedTokenCategory(e.target.value)}
                      className="border p-2 w-full break-words whitespace-normal"
                    >
                      <option value="">Select Genesis UTXO</option>
                      {selectedUtxos
                        .filter((utxo) => !utxo.token && utxo.tx_pos === 0)
                        .map((utxo, index) => (
                          <option
                            key={utxo.tx_hash + index}
                            value={utxo.tx_hash}
                          >
                            {utxo.tx_hash}
                          </option>
                        ))}
                    </select>
                  </div>

                  {/* new row with "Configure NFT" on left, "Add Output" on right */}
                  <div className="flex justify-between items-center mt-4">
                    <button
                      onClick={() => setShowNFTConfigPopup(true)}
                      className="bg-purple-500 text-white font-bold py-2 px-4 rounded"
                    >
                      Configure NFT
                    </button>

                    <button
                      onClick={handleAddOutput}
                      className="bg-blue-500 font-bold text-white py-2 px-4 rounded"
                    >
                      Add Output
                    </button>
                  </div>
                </>
              )}

              {/* The NFT config sub-popup */}
              {showNFTConfigPopup && (
                <Popup closePopups={() => setShowNFTConfigPopup(false)}>
                  <div className="p-4">
                    <h3 className="text-lg font-semibold mb-2">
                      NFT Configuration
                    </h3>
                    <div className="mb-2">
                      <label className="block font-medium mb-1">
                        NFT Capability
                      </label>
                      <select
                        value={nftCapability}
                        onChange={(e) =>
                          setNftCapability(
                            e.target.value as 'none' | 'mutable' | 'minting'
                          )
                        }
                        className="border p-2 w-full"
                      >
                        <option value="none">none</option>
                        <option value="mutable">mutable</option>
                        <option value="minting">minting</option>
                      </select>
                    </div>

                    <div className="mb-2">
                      <label className="block font-medium mb-1">
                        NFT Commitment
                      </label>
                      <input
                        type="text"
                        value={nftCommitment}
                        onChange={(e) => setNftCommitment(e.target.value)}
                        placeholder="Up to 40 bytes"
                        className="border p-2 w-full break-words whitespace-normal"
                      />
                    </div>

                    <button
                      onClick={() => setShowNFTConfigPopup(false)}
                      className="bg-blue-500 text-white font-bold py-1 px-3 rounded"
                    >
                      Done
                    </button>
                  </div>
                </Popup>
              )}

              {/* OP_RETURN if needed */}
              {showOpReturn && <>{/* user’s OP_RETURN inputs */}</>}
            </div>
          </Popup>
        )}

        {/* Change Address Input */}
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
