// src/components/CashTokenUTXOs.tsx
import React, { useEffect, useState } from 'react';
import { shortenTxHash } from '../utils/shortenHash';
import BcmrService from '../services/BcmrService';
import { IdentitySnapshot } from '@bitauth/libauth';
import { UTXO } from '../types/types';

// interface UTXO {
//   tx_hash: string;
//   tx_pos: number;
//   height: number;
//   amount: number;
//   token: string | Record<string, any> | null;
// }

interface CashTokenUTXOsProps {
  utxos: UTXO[];
  loading: boolean;
}

const CashTokenUTXOs: React.FC<CashTokenUTXOsProps> = ({ utxos, loading }) => {
  const [snapshot, setSnapshot] = useState<IdentitySnapshot | null>(null);
  const [iconUri, setIconUri] = useState<string | null>(null);

  // Safely parse token JSON or pass through if already object
  const safelyParseTokenData = (tokenData: any): Record<string, any> => {
    if (!tokenData) return {};
    if (typeof tokenData === 'string') {
      try {
        return JSON.parse(tokenData);
      } catch {
        return {};
      }
    }
    return tokenData;
  };

  useEffect(() => {
    // If there are no UTXOs or no token info, nothing to load
    if (!utxos.length) return;
    const first = safelyParseTokenData(utxos[0].token);
    const category = first.category as string | undefined;
    if (!category) return;

    const loadMetadata = async () => {
      try {
        const bcmr = new BcmrService();
        const authbase = await bcmr.getCategoryAuthbase(category);
        const idReg = await bcmr.resolveIdentityRegistry(authbase);
        const snap = bcmr.extractIdentity(authbase, idReg.registry);
        setSnapshot(snap);
        const uri = await bcmr.resolveIcon(authbase);
        setIconUri(uri);
      } catch (err) {
        console.error('Failed to load CashToken metadata', err);
      }
    };

    loadMetadata();
  }, [utxos]);

  return (
    <div>
      <h4 className="font-semibold mb-2">CashToken UTXOs:</h4>

      {loading ? (
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
          <span>Loading UTXOs...</span>
        </div>
      ) : (
        utxos.map((utxo, idx) => {
          const tokenData = safelyParseTokenData(utxo.token);

          return (
            <div
              key={idx}
              className="p-3 mb-3 border rounded-lg grid grid-cols-[1fr_auto] gap-4"
            >
              {/* Left column: existing UTXO info */}
              <div className="space-y-1 text-sm">
                <p>
                  <strong>Amount:</strong> {utxo.amount} satoshis
                </p>
                <p>
                  <strong>Token Amount:</strong> {tokenData.amount ?? 'N/A'}
                </p>
                <p>
                  <strong>Transaction:</strong> {shortenTxHash(utxo.tx_hash)}
                </p>
                <p>
                  <strong>Position:</strong> {utxo.tx_pos}
                </p>
                <p>
                  <strong>Height:</strong> {utxo.height}
                </p>
              </div>

              {/* Right column: token icon + name */}
              {snapshot && (
                <div className="flex flex-col items-center space-y-2">
                  {iconUri && (
                    <img
                      src={iconUri}
                      alt={`${snapshot.name} icon`}
                      className="w-12 h-12 rounded"
                    />
                  )}
                  <span className="text-base font-medium text-center">
                    {snapshot.name}
                  </span>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
};

export default CashTokenUTXOs;
