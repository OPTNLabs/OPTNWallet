// src/components/UTXOCard.tsx
import React, { useEffect, useState } from 'react';
import { FaBitcoin } from 'react-icons/fa';
import { shortenTxHash } from '../utils/shortenHash';
import BcmrService from '../services/BcmrService';
import { UTXO } from '../types/types';
import { IdentitySnapshot } from '@bitauth/libauth';

interface UTXOCardProps {
  utxos: UTXO[];
  loading: boolean;
}

interface TokenMeta {
  name: string;
  iconUri: string | null;
}

const UTXOCard: React.FC<UTXOCardProps> = ({ utxos, loading }) => {
  const [metaByCategory, setMetaByCategory] = useState<
    Record<string, TokenMeta>
  >({});

  // Preload metadata for each token category we see
  useEffect(() => {
    const categories = Array.from(
      new Set(
        utxos
          .map((u) => u.token)
          .filter(Boolean)
          .map((t) => (t as any).category)
      )
    ) as string[];
    if (!categories.length) return;

    const svc = new BcmrService();
    (async () => {
      const next: Record<string, TokenMeta> = {};
      for (const category of categories) {
        if (metaByCategory[category]) continue;
        try {
          const authbase = await svc.getCategoryAuthbase(category);
          const idReg = await svc.resolveIdentityRegistry(authbase);
          const snap: IdentitySnapshot = svc.extractIdentity(
            authbase,
            idReg.registry
          );
          const iconUri = await svc.resolveIcon(authbase);
          next[category] = { name: snap.name, iconUri };
        } catch (e) {
          console.error('Failed to load token metadata for', category, e);
        }
      }
      if (Object.keys(next).length) {
        setMetaByCategory((m) => ({ ...m, ...next }));
      }
    })();
  }, [utxos, metaByCategory]);

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
      {/* Optional heading */}
      <h4 className="font-semibold mb-2">UTXOs:</h4>

      {utxos.map((utxo, i) => {
        const isToken = Boolean(utxo.token);
        const tokenData = isToken
          ? typeof utxo.token === 'string'
            ? JSON.parse(utxo.token)
            : utxo.token
          : null;
        const category = isToken ? tokenData!.category : null;
        const meta = category ? metaByCategory[category] : null;

        return (
          <div
            key={i}
            className="p-3 mb-3 border rounded-lg grid grid-cols-[1fr_auto] gap-4"
          >
            {/* Left column: UTXO details */}
            <div className="space-y-1 text-sm">
              <p>
                <strong>Amount:</strong>{' '}
                {isToken ? tokenData!.amount : utxo.amount ?? utxo.value}{' '}
                {isToken ? 'tokens' : 'satoshis'}
              </p>
              {isToken && (
                <p>
                  <strong>Category:</strong> {shortenTxHash(category!)}
                </p>
              )}
              <p>
                <strong>Tx Hash:</strong> {shortenTxHash(utxo.tx_hash)}
              </p>
              <p>
                <strong>Pos:</strong> {utxo.tx_pos}
              </p>
              <p>
                <strong>Height:</strong> {utxo.height}
              </p>
            </div>

            {/* Right column: Icon + Name or Bitcoin logo */}
            <div className="flex flex-col items-center space-y-2">
              {isToken && meta ? (
                <>
                  {meta.iconUri && (
                    <img
                      src={meta.iconUri}
                      alt={meta.name}
                      className="w-12 h-12 rounded"
                    />
                  )}
                  <span className="text-base font-medium text-center">
                    {meta.name}
                  </span>
                </>
              ) : (
                <>
                  <FaBitcoin className="text-green-500 text-4xl" />
                  <span className="text-base font-medium text-center">
                    Bitcoin Cash
                  </span>
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
