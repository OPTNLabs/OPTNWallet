import React from 'react';
import { FaCamera } from 'react-icons/fa';
import { UTXO } from '../../types/types';
import { DUST } from '../../utils/constants';

interface CashTokenViewProps {
  recipientAddress: string;
  setRecipientAddress: (address: string) => void;
  transferAmount: number;
  handleTransferAmountChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  tokenAmount: number | bigint;
  handleTokenAmountChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  selectedTokenCategory: string;
  setSelectedTokenCategory: (category: string) => void;
  selectedUtxos: UTXO[];
  scanBarcode: () => void;
  handleAddOutput: () => void;
}

const CashTokenView: React.FC<CashTokenViewProps> = ({
  recipientAddress,
  setRecipientAddress,
  transferAmount,
  handleTransferAmountChange,
  tokenAmount,
  handleTokenAmountChange,
  selectedTokenCategory,
  setSelectedTokenCategory,
  selectedUtxos,
  scanBarcode,
  handleAddOutput,
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
        <label className="block font-medium mb-1">Token Amount</label>
        <input
          type="number"
          value={Number(tokenAmount)}
          onChange={handleTokenAmountChange}
          className="border p-2 w-full break-words whitespace-normal"
        />
      </div>
      <div className="mb-2">
        <label className="block font-medium mb-1">Genesis UTXO for new Token</label>
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
      <div className="flex justify-end mt-4">
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

export default CashTokenView;