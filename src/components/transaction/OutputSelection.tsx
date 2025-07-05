import React, { useState, useEffect, useMemo } from 'react';
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../../redux/store';
import { clearTransaction } from '../../redux/transactionBuilderSlice';
import { TransactionOutput, UTXO } from '../../types/types';
import { shortenTxHash } from '../../utils/shortenHash';
import { Network } from '../../redux/networkSlice';
import { PREFIX, DUST } from '../../utils/constants';
import Popup from './Popup';
import TransactionTypeSelector from './TransactionTypeSelector';
import RegularTxView from './RegularTxView';
import CashTokenView from './CashTokenView';
import NFTView from './NFTView';
import NFTConfigPopup from './NFTConfigPopup';
import OpReturnView from './OpReturnView';
import useTokenMetadata from '../../hooks/useTokenMetadata';

interface OutputSelectionProps {
  recipientAddress: string;
  setRecipientAddress: (address: string) => void;
  currentNetwork: Network;
  transferAmount: number;
  setTransferAmount: (amount: number) => void;
  tokenAmount: number | bigint;
  setTokenAmount: (amount: number | bigint) => void;
  utxos: UTXO[];
  selectedUtxos: UTXO[];
  selectedTokenCategory: string;
  setSelectedTokenCategory: (category: string) => void;
  addOutput: () => void;
  changeAddress: string;
  setChangeAddress: (address: string) => void;
  txOutputs: TransactionOutput[];
  handleRemoveOutput: (index: number) => void;
  nftCapability: undefined | 'none' | 'mutable' | 'minting';
  setNftCapability: (value: undefined | 'none' | 'mutable' | 'minting') => void;
  nftCommitment: undefined | string;
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
  selectedUtxos,
  selectedTokenCategory,
  setSelectedTokenCategory,
  addOutput,
  changeAddress,
  setChangeAddress,
  txOutputs,
  handleRemoveOutput,
  nftCapability,
  setNftCapability,
  nftCommitment,
  setNftCommitment,
}) => {
  const dispatch: AppDispatch = useDispatch();

  const [showPopup, setShowPopup] = useState(false);
  const [showAddOutputPopup, setShowAddOutputPopup] = useState(false);
  const [showRegularTx, setShowRegularTx] = useState(false);
  const [showCashToken, setShowCashToken] = useState(false);
  const [showNFTCashToken, setShowNFTCashToken] = useState(false);
  const [showOpReturn, setShowOpReturn] = useState(false);
  const [showNFTConfigPopup, setShowNFTConfigPopup] = useState(false);
  const [popupTitle, setPopupTitle] = useState('Add Output');
  const [opReturnText, setOpReturnText] = useState('');

  const hasGenesisUtxoSelected = selectedUtxos.some((utxo) => !utxo.token && utxo.tx_pos === 0);
  const categoriesFromSelected = [...new Set(selectedUtxos.filter((u) => u.token).map((u) => u.token.category))];
  const tokenMetadata = useTokenMetadata(categoriesFromSelected);

  useEffect(() => {
    if (showNFTCashToken) setTokenAmount(0);
  }, [showNFTCashToken, setTokenAmount]);

  const totalSats = useMemo(() => {
    return selectedUtxos.reduce((sum, utxo) => {
      const value = utxo.value || utxo.amount || 0; // Support both properties
      return sum + BigInt(value); // Use BigInt for consistency
    }, BigInt(0)); // Start with BigInt(0)
  }, [selectedUtxos]);

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
    setNftCapability(undefined);
    setNftCommitment(undefined);
    setOpReturnText('');
  };

  const togglePopup = () => setShowPopup((prev) => !prev);

  const handleTransferAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setTransferAmount(value === '' ? 0 : Number(value));
  };

  const handleTokenAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (showNFTCashToken) return;
    const value = e.target.value;
    setTokenAmount(value === '' ? 0 : Number(value));
  };

  const scanBarcode = async () => {
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
      });
      if (result && result.ScanResult) setRecipientAddress(result.ScanResult);
      else await Toast.show({ text: 'No QR code detected. Please try again.' });
    } catch (error) {
      console.error('Barcode scan error:', error);
      await Toast.show({ text: 'Failed to scan QR code. Please ensure camera permissions are granted and try again.' });
    }
  };

  const handleAddOutput = async () => {
    if (transferAmount < DUST) {
      await Toast.show({ text: `Transfer amount must be at least ${DUST}.` });
      return;
    }
    addOutput();
  };

  const addOpReturnOutput = async () => {
    const opReturnArray = opReturnText.split(' ').map((s) => s.trim()).filter((s) => s.length > 0);
    if (opReturnArray.length === 0) {
      await Toast.show({ text: 'OP_RETURN data cannot be empty.' });
      return;
    }
    const encoder = new TextEncoder();
    const chunks: number[] = [];
    for (const word of opReturnArray) {
      const bytes = Array.from(encoder.encode(word));
      chunks.push(bytes.length, ...bytes);
    }
    const bytecode = Uint8Array.from([0x6a, ...chunks]);
    const opReturnOutput = {
      recipientAddress: 'OP_RETURN',
      amount: 0,
      token: null,
      lockingBytecode: bytecode,
    };
    dispatch({ type: 'transactionBuilder/addOutput', payload: opReturnOutput });
    setShowAddOutputPopup(false);
  };

  return (
    <>
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
                          <span>{output.token.amount ? output.token.amount.toString() : 'NFT'}</span>
                        </div>
                        <div className="flex justify-between w-full">
                          <span className="font-medium">Category:</span>
                          <span>{output.token.category}</span>
                        </div>
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
            <h3 className="text-lg font-semibold">
              {`${txOutputs.length} Recipient${txOutputs.length === 1 ? '' : 's'} - Total: ${txOutputs.reduce(
                (sum, utxo) => sum + Number(utxo.amount),
                0
              )}`}
            </h3>
          </div>
        )}
        {txOutputs.length < 10 && (
          <div className="mb-6 flex flex-col items-end">
            <button
              onClick={() => {
                resetFormValues();
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
        {showAddOutputPopup && (
          <Popup closePopups={() => setShowAddOutputPopup(false)}>
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-2">{popupTitle}</h3>
              <TransactionTypeSelector
                showRegularTx={showRegularTx}
                setShowRegularTx={setShowRegularTx}
                showCashToken={showCashToken}
                setShowCashToken={setShowCashToken}
                showNFTCashToken={showNFTCashToken}
                setShowNFTCashToken={setShowNFTCashToken}
                showOpReturn={showOpReturn}
                setShowOpReturn={setShowOpReturn}
                hasGenesisUtxoSelected={hasGenesisUtxoSelected}
                resetFormValues={resetFormValues}
                setPopupTitle={setPopupTitle}
              />
              {showRegularTx && (
                <RegularTxView
                  recipientAddress={recipientAddress}
                  setRecipientAddress={setRecipientAddress}
                  transferAmount={transferAmount}
                  setTransferAmount={setTransferAmount}
                  categoriesFromSelected={categoriesFromSelected}
                  tokenAmount={tokenAmount}
                  setTokenAmount={setTokenAmount}
                  selectedTokenCategory={selectedTokenCategory}
                  setSelectedTokenCategory={setSelectedTokenCategory}
                  tokenMetadata={tokenMetadata}
                  selectedUtxos={selectedUtxos}
                  scanBarcode={scanBarcode}
                  handleAddOutput={handleAddOutput}
                />
              )}
              {showCashToken && (
                <CashTokenView
                  recipientAddress={recipientAddress}
                  setRecipientAddress={setRecipientAddress}
                  transferAmount={transferAmount}
                  handleTransferAmountChange={handleTransferAmountChange}
                  tokenAmount={tokenAmount}
                  handleTokenAmountChange={handleTokenAmountChange}
                  selectedTokenCategory={selectedTokenCategory}
                  setSelectedTokenCategory={setSelectedTokenCategory}
                  selectedUtxos={selectedUtxos}
                  scanBarcode={scanBarcode}
                  handleAddOutput={handleAddOutput}
                />
              )}
              {showNFTCashToken && (
                <NFTView
                  recipientAddress={recipientAddress}
                  setRecipientAddress={setRecipientAddress}
                  transferAmount={transferAmount}
                  handleTransferAmountChange={handleTransferAmountChange}
                  tokenAmount={tokenAmount}
                  selectedTokenCategory={selectedTokenCategory}
                  setSelectedTokenCategory={setSelectedTokenCategory}
                  selectedUtxos={selectedUtxos}
                  scanBarcode={scanBarcode}
                  handleAddOutput={handleAddOutput}
                  setShowNFTConfigPopup={setShowNFTConfigPopup}
                />
              )}
              {showOpReturn && (
                <OpReturnView
                  opReturnText={opReturnText}
                  setOpReturnText={setOpReturnText}
                  addOpReturnOutput={addOpReturnOutput}
                />
              )}
              <NFTConfigPopup
                show={showNFTConfigPopup}
                setShow={setShowNFTConfigPopup}
                nftCapability={nftCapability}
                setNftCapability={setNftCapability}
                nftCommitment={nftCommitment}
                setNftCommitment={setNftCommitment}
              />
            </div>
          </Popup>
        )}
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