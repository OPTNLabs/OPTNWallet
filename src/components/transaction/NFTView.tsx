import React from 'react';
import { FaCamera } from 'react-icons/fa';
import { UTXO } from '../../types/types';
import { DUST } from '../../utils/constants';

interface NFTViewProps {
  recipientAddress: string;
  setRecipientAddress: (address: string) => void;
  transferAmount: number;
  handleTransferAmountChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  tokenAmount: number | bigint;
  selectedTokenCategory: string;
  setSelectedTokenCategory: (category: string) => void;
  selectedUtxos: UTXO[];
  scanBarcode: () => void;
  handleAddOutput: () => void;
  setShowNFTConfigPopup: (value: boolean) => void;
}

const NFTView: React.FC<NFTViewProps> = ({
  recipientAddress,
  setRecipientAddress,
  transferAmount,
  handleTransferAmountChange,
  tokenAmount,
  selectedTokenCategory,
  setSelectedTokenCategory,
  selectedUtxos,
  scanBarcode,
  handleAddOutput,
  setShowNFTConfigPopup,
}) => {
  return (
    <>
      <label className="block font-medium mb-1">Recipient Address</label>
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
        <label className="block font-medium mb-1">Transfer Amount (Sats)</label>
        <input
          type="number"
          value={transferAmount}
          onChange={handleTransferAmountChange}
          className="border p-2 w-full break-words whitespace-normal"
          min={DUST}
        />
      </div>
      <div className="mb-2">
        <label className="block font-medium mb-1">NFT Token Amount</label>
        <input
          type="number"
          value={Number(tokenAmount)}
          onChange={() => {}} // Disabled
          className="border p-2 w-full break-words whitespace-normal"
          disabled
        />
      </div>
      <div className="mb-2">
        <label className="block font-medium mb-1">Genesis UTXO for new NFT</label>
        <select
          value={selectedTokenCategory}
          onChange={(e) => setSelectedTokenCategory(e.target.value)}
          className="border p-2 w-full break-words whitespace-normal"
        >
          <option value="">Select Genesis UTXO</option>
          {selectedUtxos
            .filter((utxo) => !utxo.token && utxo.tx_pos === 0)
            .map((utxo, index) => (
              <option key={utxo.tx_hash + index} value={utxo.tx_hash}>
                {utxo.tx_hash}
              </option>
            ))}
        </select>
      </div>
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
  );
};

export default NFTView;