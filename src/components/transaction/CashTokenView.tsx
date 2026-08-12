import React from 'react';
import { FaCamera } from 'react-icons/fa';
import { UTXO } from '../../types/types';
import { DUST } from '../../utils/constants';
import TokenAvatar from '../ui/TokenAvatar';

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
  selectedTokenMetadata?: {
    name?: string | null;
    symbol?: string | null;
    iconUri?: string | null;
  } | null;
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
  selectedTokenMetadata = null,
}) => {
  const tokenName = selectedTokenMetadata?.name || 'CashToken';
  const tokenSymbol = selectedTokenMetadata?.symbol || 'token';
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <TokenAvatar iconUri={selectedTokenMetadata?.iconUri ?? null} name={tokenName} />
        <div>
          <div className="text-base font-semibold wallet-text-strong">{tokenName}</div>
          <div className="text-sm wallet-muted">{tokenSymbol}</div>
        </div>
      </div>
      <label className="block font-medium mb-1">Recipient Address</label>
      <div className="flex items-center mb-2">
        <input
          type="text"
          value={recipientAddress}
          onChange={(e) => setRecipientAddress(e.target.value)}
          className="wallet-input p-2 w-full break-words whitespace-normal"
        />
        <button
          onClick={scanBarcode}
          className="ml-2 wallet-btn-primary p-2"
          title="Scan QR Code"
        >
          <FaCamera />
        </button>
      </div>
      <div className="mb-2">
        <label className="block font-medium mb-1">BCH amount (sats)</label>
        <input
          type="number"
          value={transferAmount}
          onChange={handleTransferAmountChange}
          className="wallet-input p-2 w-full break-words whitespace-normal"
          min={DUST}
        />
      </div>
      <div className="mb-2">
        <label className="block font-medium mb-1">Token amount</label>
        <input
          type="number"
          value={
            typeof tokenAmount === 'bigint'
              ? tokenAmount.toString()
              : String(tokenAmount ?? '')
          }
          onChange={handleTokenAmountChange}
          className="wallet-input p-2 w-full break-words whitespace-normal"
        />
      </div>
      <div className="mb-2">
        <label className="block font-medium mb-1">
          Genesis input for this token
        </label>
        <select
          value={selectedTokenCategory}
          onChange={(e) => setSelectedTokenCategory(e.target.value)}
          className="wallet-input p-2 w-full break-words whitespace-normal"
        >
          <option value="">Select genesis input</option>
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
          className="wallet-btn-primary font-bold py-2 px-4"
        >
          Add recipient
        </button>
      </div>
    </>
  );
};

export default CashTokenView;
