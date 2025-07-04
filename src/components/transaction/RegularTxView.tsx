import React, { useState, useEffect, useMemo } from 'react';
import { FaCamera } from 'react-icons/fa';
import { UTXO } from '../../types/types';
import { shortenTxHash } from '../../utils/shortenHash';
import { DUST } from '../../utils/constants';

interface RegularTxViewProps {
  recipientAddress: string;
  setRecipientAddress: (address: string) => void;
  transferAmount: number;
  setTransferAmount: (amount: number) => void;
  categoriesFromSelected: string[];
  tokenAmount: number | bigint;
  setTokenAmount: (amount: number) => void;
  selectedTokenCategory: string;
  setSelectedTokenCategory: (category: string) => void;
  tokenMetadata: Record<string, { name: string; symbol: string; decimals: number; iconUri: string | null }>;
  selectedUtxos: UTXO[];
  scanBarcode: () => void;
  handleAddOutput: () => void;
}

const RegularTxView: React.FC<RegularTxViewProps> = ({
  recipientAddress,
  setRecipientAddress,
  transferAmount,
  setTransferAmount,
  categoriesFromSelected,
  tokenAmount,
  setTokenAmount,
  selectedTokenCategory,
  setSelectedTokenCategory,
  tokenMetadata,
  selectedUtxos,
  scanBarcode,
  handleAddOutput,
}) => {
  const [inputTokenAmount, setInputTokenAmount] = useState<string>('');

  const isNft = selectedTokenCategory && selectedTokenCategory !== 'none'
    ? selectedUtxos.some((u) => u.token?.category === selectedTokenCategory && u.token.nft)
    : false;

  const totalSats = useMemo(() => {
    return selectedUtxos.reduce((sum, utxo) => sum + (utxo.value || 0), 0);
  }, [selectedUtxos]);

  const tokenTotals = useMemo(() => {
    const totals: Record<string, bigint> = {};
    selectedUtxos.forEach(utxo => {
      if (utxo.token) {
        const category = utxo.token.category;
        const amount = utxo.token.amount;
        const current = totals[category] || BigInt(0);
        totals[category] = current + BigInt(amount);
      }
    });
    return totals;
  }, [selectedUtxos]);

  const formatTokenAmount = (amount: bigint, decimals: number): string => {
    if (decimals === 0) {
      return amount.toString();
    }
    const amountStr = amount.toString();
    const padded = amountStr.padStart(decimals + 1, '0');
    const integerPart = padded.slice(0, -decimals) || '0';
    const decimalPart = padded.slice(-decimals).padEnd(decimals, '0');
    return `${integerPart}.${decimalPart}`;
  };

  useEffect(() => {
    if (selectedTokenCategory === 'none') {
      setInputTokenAmount('');
      setTokenAmount(0);
    } else if (isNft) {
      setInputTokenAmount('1');
      setTokenAmount(1);
    } else {
      setInputTokenAmount('');
      setTokenAmount(0);
    }
  }, [selectedTokenCategory, isNft, setTokenAmount]);

  const handleInputTokenAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    const decimals = tokenMetadata[selectedTokenCategory]?.decimals || 0;
    const maxTokenAmount = tokenTotals[selectedTokenCategory] || BigInt(0);

    const regex = new RegExp(`^\\d*\\.?\\d{0,${decimals}}$`);
    if (regex.test(value) || value === '') {
      setInputTokenAmount(value);

      if (!isNft && selectedTokenCategory && tokenMetadata[selectedTokenCategory]) {
        try {
          const amount = parseFloat(value);
          if (!isNaN(amount)) {
            const multiplier = Math.pow(10, decimals);
            const integerAmount = Math.round(amount * multiplier);
            if (BigInt(integerAmount) > maxTokenAmount) {
              console.warn('Token amount exceeds available balance');
              const maxFormatted = formatTokenAmount(maxTokenAmount, decimals);
              setInputTokenAmount(maxFormatted);
              setTokenAmount(Number(maxTokenAmount));
            } else {
              setTokenAmount(integerAmount);
            }
          } else {
            setTokenAmount(0);
          }
        } catch (error) {
          console.error('Error parsing token amount:', error);
          setTokenAmount(0);
        }
      }
    }
  };

  return (
    <>
      <div className="mb-2">
        <label className="block font-medium mb-1">Recipient Address</label>
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
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <label className="font-medium">Transfer Amount (Sats)</label>
          <div className="flex space-x-2">
            <button
              onClick={() => setTransferAmount(totalSats - 2000)}
              className="border border-gray-300 bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 transition-colors"
            >
              Max ({totalSats < 2000 ? 0 : totalSats - 2000})
            </button>
          </div>
        </div>
        <input
          type="number"
          value={totalSats < 2000 ? 0 : transferAmount > totalSats - 2000 ? totalSats - 2000 : transferAmount}
          onChange={(e) => {
            const value = e.target.value;
            setTransferAmount(value === '' ? 0 : Number(value));
          }}
          className="border p-2 w-full break-words whitespace-normal"
          min={DUST}
          max={totalSats}
        />
      </div>
      {selectedTokenCategory && selectedTokenCategory !== 'none' && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <label className="font-medium">
              Token Amount{' '}
              {tokenMetadata[selectedTokenCategory]
                ? `(${tokenMetadata[selectedTokenCategory].symbol})`
                : ''}
            </label>
            {!isNft && (
              <div className="flex space-x-2">
                <button
                  onClick={() => {
                    const maxTokenAmount = tokenTotals[selectedTokenCategory] || BigInt(0);
                    const decimals = tokenMetadata[selectedTokenCategory]?.decimals || 0;
                    const formattedMax = formatTokenAmount(maxTokenAmount, decimals);
                    setInputTokenAmount(formattedMax);
                    setTokenAmount(Number(maxTokenAmount));
                  }}
                  className="border border-gray-300 bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 transition-colors"
                >
                  Max ({formatTokenAmount(tokenTotals[selectedTokenCategory] || BigInt(0), tokenMetadata[selectedTokenCategory]?.decimals || 0)})
                </button>
              </div>
            )}
          </div>
          {isNft ? (
            <input
              type="number"
              value={0}
              disabled
              readOnly
              className="border p-2 w-full break-words whitespace-normal text-gray-400 bg-gray-100"
            />
          ) : (
            <input
              type="text"
              value={inputTokenAmount}
              onChange={handleInputTokenAmountChange}
              className="border p-2 w-full break-words whitespace-normal"
              placeholder={`Enter amount (max ${formatTokenAmount(tokenTotals[selectedTokenCategory] || BigInt(0), tokenMetadata[selectedTokenCategory]?.decimals || 0)})`}
            />
          )}
        </div>
      )}
      <div className="mb-2">
        <label className="block font-medium mb-1">Token Category</label>
        <select
          value={selectedTokenCategory}
          onChange={(e) => setSelectedTokenCategory(e.target.value)}
          className="border p-2 w-full break-words whitespace-normal"
        >
          <option value="none">None</option>
          {categoriesFromSelected.map((category) => {
            const meta = tokenMetadata[category];
            return (
              <option key={category} value={category}>
                {meta?.name ?? shortenTxHash(category)}
              </option>
            );
          })}
        </select>
        {selectedTokenCategory !== 'none' && tokenMetadata[selectedTokenCategory] && (
          <div className="flex justify-between items-center mt-2">
            <div className="flex items-center">
              {tokenMetadata[selectedTokenCategory].iconUri && (
                <img
                  src={tokenMetadata[selectedTokenCategory].iconUri}
                  alt={tokenMetadata[selectedTokenCategory].name}
                  className="w-6 h-6 rounded mr-2"
                />
              )}
              <span className="font-medium">{tokenMetadata[selectedTokenCategory].name}</span>
            </div>
            <span className="text-sm font-medium">{isNft ? 'NFT' : 'FT'}</span>
          </div>
        )}
      </div>
      <div className="flex justific-end mt-4">
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

export default RegularTxView;