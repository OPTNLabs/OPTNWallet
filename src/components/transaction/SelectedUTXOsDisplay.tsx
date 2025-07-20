// src/components/transaction/SelectedUTXOsDisplay.tsx

import { useState, useEffect } from 'react';
import { FaBitcoin } from 'react-icons/fa';
import { UTXO } from '../../types/types';
import Popup from './Popup';
import { shortenTxHash } from '../../utils/shortenHash';
import { PREFIX, SATSINBITCOIN } from '../../utils/constants';
import { Network } from '../../redux/networkSlice';
import BcmrService from '../../services/BcmrService';
import { IdentitySnapshot } from '@bitauth/libauth';

interface SelectedUTXOsDisplayProps {
  selectedUtxos: UTXO[];
  selectedAddresses: string[];
  selectedContractAddresses: string[];
  totalSelectedUtxoAmount: BigInt;
  handleUtxoClick: (utxo: UTXO) => void;
  currentNetwork: Network;
}

export default function SelectedUTXOsDisplay({
  selectedUtxos,
  selectedAddresses,
  selectedContractAddresses,
  totalSelectedUtxoAmount,
  handleUtxoClick,
  currentNetwork,
}: SelectedUTXOsDisplayProps) {
  const [showPopup, setShowPopup] = useState(false);

  // Updated tokenMetadata to include symbol and decimals
  const [tokenMetadata, setTokenMetadata] = useState<
    Record<
      string,
      { name: string; symbol: string; decimals: number; iconUri: string | null }
    >
  >({});

  // Function to format token amounts based on decimals
  const formatTokenAmount = (
    amount: number | string | bigint,
    decimals: number = 0
  ): string => {
    const numAmount =
      typeof amount === 'string' ? parseFloat(amount) : Number(amount);
    if (decimals === 0) return numAmount.toString();
    const divisor = Math.pow(10, decimals);
    const formatted = (numAmount / divisor).toFixed(decimals);
    return formatted.replace(/\.?0+$/, ''); // Remove trailing zeros
  };

  // Fetch token metadata when categories change
  useEffect(() => {
    const svc = new BcmrService();
    const missing = selectedUtxos
      .map((u) => u.token?.category)
      .filter((c): c is string => !!c && !(c in tokenMetadata));

    if (missing.length === 0) return;

    (async () => {
      const newMeta: typeof tokenMetadata = {};
      for (const category of missing) {
        try {
          const authbase = await svc.getCategoryAuthbase(category);
          const reg = await svc.resolveIdentityRegistry(authbase);
          const snap: IdentitySnapshot = svc.extractIdentity(
            authbase,
            reg.registry
          );
          const iconUri = await svc.resolveIcon(authbase);
          // Extract decimals and symbol from the snapshot
          const decimals = snap.token?.decimals || 0;
          const symbol = snap.token?.symbol || '';
          newMeta[category] = { name: snap.name, symbol, decimals, iconUri };
          // console.log('Fetched metadata for', category, newMeta[category]);
        } catch (e) {
          // console.error('Failed loading metadata for', category, e);
        }
      }
      // Merge into cache
      setTokenMetadata((prev) => ({ ...prev, ...newMeta }));
    })();
  }, [selectedUtxos, tokenMetadata]);

  const togglePopup = () => setShowPopup((v) => !v);

  return (
    <div className="mb-4">
      {selectedUtxos.length > 0 ? (
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold ">Transaction Inputs</h3>
          <button
            onClick={togglePopup}
            className="bg-blue-500 font-bold text-white py-1 px-2 rounded hover:bg-blue-600 transition-colors duration-200"
          >
            Show Inputs
          </button>
        </div>
      ) : selectedAddresses.length > 0 ||
        selectedContractAddresses.length > 0 ? (
        <div className="font-bold flex-col text-xl">
          (2) Select UTXO(s) to spend from
        </div>
      ) : (
        <></>
      )}

      {showPopup && (
        <Popup closePopups={() => setShowPopup(false)}>
          <h3 className="text-lg font-semibold flex flex-col items-center mb-4">
            Transaction Inputs
          </h3>
          <div className="max-h-[50vh] overflow-y-auto">
            {selectedUtxos.length === 0 ? (
              <p>No UTXOs selected.</p>
            ) : (
              selectedUtxos.map((utxo) => {
                const key = utxo.id ?? `${utxo.tx_hash}-${utxo.tx_pos}`;
                const isToken = !!utxo.token; // Check if it's a CashToken
                const cat = utxo.token?.category;
                const meta = cat ? tokenMetadata[cat] : null;

                return (
                  <button
                    key={key}
                    onClick={() => handleUtxoClick(utxo)}
                    className="flex flex-col items-start mb-2 w-full break-words whitespace-normal border p-2 rounded bg-blue-100"
                  >
                    {/* Address */}
                    <span className="w-full">
                      {/* Address:{' '} */}
                      {shortenTxHash(
                        meta ? utxo.tokenAddress : utxo.address,
                        PREFIX[currentNetwork].length
                      )}
                    </span>

                    {/* Conditional rendering based on whether it's a token */}
                    {isToken ? (
                      <span className="w-full">
                        Amount:{' '}
                        {formatTokenAmount(
                          utxo.token!.amount,
                          meta?.decimals || 0
                        )}{' '}
                        {meta?.symbol || 'tokens'}
                      </span>
                    ) : (
                      <>
                        <span className="w-full">
                          {(utxo.amount != null ? utxo.amount : utxo.value) /
                            SATSINBITCOIN}{' '}
                          BCH
                        </span>
                        <span className="w-full">
                          Tx Hash: {shortenTxHash(utxo.tx_hash)}
                        </span>
                        {/* <span className="w-full">Position: {utxo.tx_pos}</span> */}
                      </>
                    )}

                    {/* Contract Function */}
                    {utxo.contractFunction && (
                      <span className="w-full">
                        Contract Function: {utxo.contractFunction}
                      </span>
                    )}
                    {!utxo.unlocker && utxo.abi && (
                      <span className="text-red-500 w-full">
                        Missing unlocker!
                      </span>
                    )}

                    {/* Token Metadata Preview */}
                    <div className="flex justify-between items-center mt-2">
                      {meta ? (
                        <>
                          <div className="flex items-center">
                            {meta.iconUri && (
                              <img
                                src={meta.iconUri}
                                alt={meta.name}
                                className="w-6 h-6 rounded mr-2"
                              />
                            )}
                            <span className="font-medium">{meta.name}</span>
                          </div>
                          <span className="text-sm font-medium">
                            {utxo.token?.nft ? 'NFT' : 'FT'}
                          </span>
                        </>
                      ) : (
                        <>
                          <div className="flex items-center">
                            <FaBitcoin className="text-green-500 text-3xl mr-2" />
                            <span className="font-medium">Bitcoin Cash</span>
                          </div>
                          <span />
                        </>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </Popup>
      )}

      {selectedUtxos.length > 0 && (
        <div className="mt-4">
          <h3 className="text-lg font-semibold">
            {`${selectedUtxos.length} Input${selectedUtxos.length === 1 ? '' : 's'} - ${Number(totalSelectedUtxoAmount) / SATSINBITCOIN} BCH`}
          </h3>
        </div>
      )}
    </div>
  );
}
