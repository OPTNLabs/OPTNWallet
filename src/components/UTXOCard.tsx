// src/components/UTXOCard.tsx
import React, { useState, useEffect } from 'react';
import { FaBitcoin } from 'react-icons/fa';
import { shortenTxHash } from '../utils/shortenHash';
import { UTXO } from '../types/types';
import BcmrService from '../services/BcmrService';

interface UTXOCardProps {
  utxos: UTXO[];
  loading: boolean;
}

const UTXOCard: React.FC<UTXOCardProps> = ({ utxos, loading }) => {
  // State to store icon data URIs, keyed by category
  const [iconUris, setIconUris] = useState<Record<string, string | null>>({});

  // Fetch icons when utxos change
  useEffect(() => {
    const fetchIcons = async () => {
      // Get unique token categories from utxos
      const categories = Array.from(
        new Set(utxos.filter(u => u.token).map(u => u.token!.category))
      );
      const bcmr = new BcmrService();

      for (const category of categories) {
        // Skip if already fetched or in progress
        if (iconUris[category] !== undefined) continue;

        try {
          const authbase = await bcmr.getCategoryAuthbase(category);
          const iconUri = await bcmr.resolveIcon(authbase);
          setIconUris(prev => ({ ...prev, [category]: iconUri }));
        } catch (error) {
          // console.error(`Failed to fetch icon for category ${category}:`, error);
          setIconUris(prev => ({ ...prev, [category]: null }));
        }
      }
    };

    fetchIcons();
  }, [utxos]); // Re-run when utxos change

  // Function to format token amounts based on decimals
  const formatTokenAmount = (amount: number | string | bigint, decimals: number = 0): string => {
    const numAmount = typeof amount === 'string' ? parseFloat(amount) : Number(amount);
    if (decimals === 0) return numAmount.toString();
    const divisor = Math.pow(10, decimals);
    const formatted = (numAmount / divisor).toFixed(decimals);
    return formatted.replace(/\.?0+$/, ''); // Remove trailing zeros
  };

  if (loading) {
    return (
      <div className="flex items-center text-gray-500">
        <svg className="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v8H4z"
          />
        </svg>
        <span>Loading UTXOs…</span>
      </div>
    );
  }

  return (
    <div>
      <h4 className="font-semibold mb-2">UTXOs:</h4>
      {utxos.map((utxo, i) => {
        const isToken = Boolean(utxo.token);
        const tokenData = isToken ? utxo.token : null;
        const metadata = tokenData?.BcmrTokenMetadata || null;
        const category = tokenData?.category || null;
        const iconUri = category ? iconUris[category] : null;

        return (
          <div
            key={i}
            className="p-3 mb-3 border rounded-lg grid grid-cols-[1fr_auto] gap-4"
          >
            <div className="space-y-1 text-sm">
              {isToken ? (
                <>
                  <p>
                    <strong>Amount:</strong>{' '}
                    {formatTokenAmount(tokenData!.amount, metadata?.token.decimals || 0)}{' '}
                    {metadata?.token.symbol || 'tokens'}
                  </p>
                  <p>
                    <strong>Name:</strong> {metadata?.name || 'Unknown Token'}
                  </p>
                  <p>
                    <strong>Satoshis:</strong> {utxo.value} sats
                  </p>
                </>
              ) : (
                <>
                  <p>
                    <strong>Amount:</strong> {(utxo.amount ?? utxo.value).toString()} satoshis
                  </p>
                  <p>
                    <strong>Tx Hash:</strong> {shortenTxHash(utxo.tx_hash)}
                  </p>
                  <p>
                    <strong>Pos:</strong> {utxo.tx_pos}
                  </p>
                  <p>
                    <strong>Height:</strong> {utxo.height}
                  </p>
                </>
              )}
            </div>
            <div className="flex flex-col items-center space-y-2">
              {isToken && metadata ? (
                <>
                  {iconUri !== undefined ? (
                    iconUri ? (
                      <img
                        src={iconUri}
                        alt={metadata.name || 'Token'}
                        className="w-12 h-12 rounded"
                      />
                    ) : (
                      <div className="w-12 h-12 bg-gray-200 rounded flex items-center justify-center">
                        <span className="text-gray-500">No Icon</span>
                      </div>
                    )
                  ) : (
                    <div className="w-12 h-12 bg-gray-200 rounded flex items-center justify-center">
                      <span className="text-gray-500">Loading...</span>
                    </div>
                  )}
                  <span className="text-base font-medium text-center">
                    {metadata.name || 'Unknown Token'}
                  </span>
                </>
              ) : (
                <>
                  <FaBitcoin className="text-green-500 text-4xl" />
                  <span className="text-base font-medium text-center">Bitcoin Cash</span>
                </>
              )}
            </div>
          </div>
        );
      })}
      {!utxos.length && <p className="text-gray-500">No UTXOs to display.</p>}
    </div>
  );
};

export default UTXOCard;