import React, { useState, useEffect, useMemo } from 'react';
import { FaCamera } from 'react-icons/fa';
import { TransactionOutput, UTXO } from '../../types/types';
import { shortenTxHash } from '../../utils/shortenHash';
import { DUST, SATSINBITCOIN } from '../../utils/constants';

interface RegularTxViewProps {
  recipientAddress: string;
  setRecipientAddress: (address: string) => void;
  transferAmount: number;
  setTransferAmount: (amount: number) => void;
  categoriesFromSelected: string[];
  tokenAmount: number | bigint;
  setTokenAmount: (amount: number | bigint) => void; // ✅ fix: allow bigint too (matches OutputSelection)
  selectedTokenCategory: string;
  setSelectedTokenCategory: (category: string) => void;
  tokenMetadata: Record<
    string,
    { name: string; symbol: string; decimals: number; iconUri: string | null }
  >;
  selectedUtxos: UTXO[];
  scanBarcode: () => Promise<void>; // ✅ fix: matches OutputSelection's async scanBarcode
  handleAddOutput: () => Promise<void>; // ✅ fix: matches OutputSelection's async handleAddOutput
  txOutputs: TransactionOutput[];
}

const RegularTxView: React.FC<RegularTxViewProps> = ({
  recipientAddress,
  setRecipientAddress,
  transferAmount,
  setTransferAmount,
  categoriesFromSelected,
  // tokenAmount,
  setTokenAmount,
  selectedTokenCategory,
  setSelectedTokenCategory,
  tokenMetadata,
  selectedUtxos,
  scanBarcode,
  handleAddOutput,
  txOutputs,
}) => {
  const [inputTokenAmount, setInputTokenAmount] = useState<string>('');

  // Reserve 2000 sats to cover fees (~1 sat/byte * <=2000 bytes)
  const FEE_RESERVE_SATS = 2000n;

  const isNft =
    selectedTokenCategory && selectedTokenCategory !== 'none'
      ? selectedUtxos.some(
          (u) => u.token?.category === selectedTokenCategory && u.token.nft
        )
      : false;

  // Total available sats from inputs
  const totalSats = useMemo(() => {
    return selectedUtxos.reduce((sum, utxo) => {
      const value = utxo.value || utxo.amount || 0; // Support both properties
      return sum + BigInt(value);
    }, BigInt(0));
  }, [selectedUtxos]);

  // Total sats already allocated to outputs
  const totalOutputAmount = useMemo(() => {
    return txOutputs.reduce((sum, output) => {
      // Only count regular outputs (ignore OP_RETURN which has no amount)
      if ('amount' in output && output.amount !== undefined) {
        if (typeof output.amount === 'bigint') return sum + output.amount;
        if (typeof output.amount === 'number')
          return sum + BigInt(output.amount);
      }
      return sum;
    }, BigInt(0));
  }, [txOutputs]);

  // Spendable = inputs - already allocated - fee reserve (floored at 0)
  const remainingSpendable = useMemo(() => {
    const rem = totalSats - totalOutputAmount - FEE_RESERVE_SATS;
    return rem > 0n ? rem : 0n;
  }, [totalSats, totalOutputAmount]);

  const tokenTotals = useMemo(() => {
    const totals: Record<string, bigint> = {};
    selectedUtxos.forEach((utxo) => {
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
    console.log(txOutputs);
  }, [txOutputs]);

  useEffect(() => {
    if (selectedTokenCategory === 'none') {
      setInputTokenAmount('');
      setTokenAmount(0n); // ✅ keep consistent type (but still accepts number)
    } else if (isNft) {
      setInputTokenAmount('1');
      setTokenAmount(1n);
    } else {
      setInputTokenAmount('');
      setTokenAmount(0n);
    }
  }, [selectedTokenCategory, isNft, setTokenAmount]);

  const handleInputTokenAmountChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const value = e.target.value;
    const decimals = tokenMetadata[selectedTokenCategory]?.decimals || 0;
    const maxTokenAmount = tokenTotals[selectedTokenCategory] || BigInt(0);

    const regex = new RegExp(`^\\d*\\.?\\d{0,${decimals}}$`);
    if (regex.test(value) || value === '') {
      setInputTokenAmount(value);

      if (
        !isNft &&
        selectedTokenCategory &&
        tokenMetadata[selectedTokenCategory]
      ) {
        try {
          const amount = parseFloat(value);
          if (!isNaN(amount)) {
            const multiplier = Math.pow(10, decimals);
            const integerAmount = Math.round(amount * multiplier);

            if (BigInt(integerAmount) > maxTokenAmount) {
              console.warn('Token amount exceeds available balance');
              const maxFormatted = formatTokenAmount(maxTokenAmount, decimals);
              setInputTokenAmount(maxFormatted);
              setTokenAmount(maxTokenAmount); // ✅ fix: pass bigint directly (no Number truncation)
            } else {
              setTokenAmount(BigInt(integerAmount)); // ✅ fix: pass bigint directly
            }
          } else {
            setTokenAmount(0n);
          }
        } catch (error) {
          console.error('Error parsing token amount:', error);
          setTokenAmount(0n);
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
            onClick={() => void scanBarcode()} // ✅ avoid unhandled promise
            className="ml-2 bg-green-500 text-white p-2 rounded"
            title="Scan QR Code"
          >
            <FaCamera />
          </button>
        </div>
      </div>

      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <label className="font-medium">Transfer Amount</label>
          <div className="flex space-x-2">
            <button
              onClick={() => setTransferAmount(Number(remainingSpendable))}
              disabled={remainingSpendable === 0n}
              className={`border border-gray-300 px-3 py-1 rounded transition-colors ${
                remainingSpendable === 0n
                  ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                  : 'bg-blue-500 text-white hover:bg-blue-600'
              }`}
              title={
                remainingSpendable === 0n
                  ? 'No spendable balance after fee reserve'
                  : 'Set to maximum spendable (leaves 2000 sats for fees)'
              }
            >
              Max{' '}
              <span className="text-sm">
                {Number(remainingSpendable) / SATSINBITCOIN}
              </span>{' '}
              BCH
            </button>
          </div>
        </div>

        <input
          type="number"
          step="0.00000001"
          value={
            transferAmount > Number(remainingSpendable)
              ? Number(remainingSpendable) / 100_000_000
              : transferAmount / 100_000_000
          }
          onChange={(e) => {
            const value = e.target.value;
            const satoshis =
              value === ''
                ? BigInt(0)
                : BigInt(Math.round(parseFloat(value) * 100_000_000));
            setTransferAmount(Number(satoshis));
          }}
          className="border p-2 w-full break-words whitespace-normal"
          min={Number(DUST) / 100_000_000}
          max={Number(remainingSpendable) / 100_000_000}
        />

        <div className="mt-1 text-xs text-gray-600">
          Leaving a {Number(FEE_RESERVE_SATS)} sat fee reserve.
        </div>
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
                    const maxTokenAmount =
                      tokenTotals[selectedTokenCategory] || BigInt(0);
                    const decimals =
                      tokenMetadata[selectedTokenCategory]?.decimals || 0;
                    const formattedMax = formatTokenAmount(
                      maxTokenAmount,
                      decimals
                    );
                    setInputTokenAmount(formattedMax);
                    setTokenAmount(maxTokenAmount); // ✅ fix: bigint safe
                  }}
                  className="border border-gray-300 bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 transition-colors"
                >
                  Max (
                  {formatTokenAmount(
                    tokenTotals[selectedTokenCategory] || BigInt(0),
                    tokenMetadata[selectedTokenCategory]?.decimals || 0
                  )}
                  )
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
              placeholder={`Enter amount (max ${formatTokenAmount(
                tokenTotals[selectedTokenCategory] || BigInt(0),
                tokenMetadata[selectedTokenCategory]?.decimals || 0
              )})`}
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

        {selectedTokenCategory !== 'none' &&
          tokenMetadata[selectedTokenCategory] && (
            <div className="flex justify-between items-center mt-2">
              <div className="flex items-center">
                {tokenMetadata[selectedTokenCategory].iconUri && (
                  <img
                    src={tokenMetadata[selectedTokenCategory].iconUri}
                    alt={tokenMetadata[selectedTokenCategory].name}
                    className="w-6 h-6 rounded mr-2"
                  />
                )}
                <span className="font-medium">
                  {tokenMetadata[selectedTokenCategory].name}
                </span>
              </div>
              <span className="text-sm font-medium">
                {isNft ? 'NFT' : 'FT'}
              </span>
            </div>
          )}
      </div>

      <div className="flex flex-col items-end justific-end mt-4">
        <button
          onClick={() => void handleAddOutput()} // ✅ avoid unhandled promise
          className="bg-blue-500 font-bold text-white py-2 px-4 rounded"
        >
          Add Output
        </button>
      </div>
    </>
  );
};

export default RegularTxView;
