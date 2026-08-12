// src/components/transaction/SelectedUTXOsDisplay.tsx

import { useState, useEffect } from 'react';
import { FaBitcoin } from 'react-icons/fa';
import { UTXO } from '../../types/types';
import Popup from './Popup';
import { shortenTxHash } from '../../utils/shortenHash';
import { PREFIX } from '../../utils/constants';
import { Network } from '../../redux/networkSlice';
import BcmrService from '../../services/BcmrService';
import { IdentitySnapshot } from '@bitauth/libauth';
import { useSelector } from 'react-redux';
import { RootState } from '../../redux/store';

interface SelectedUTXOsDisplayProps {
  selectedUtxos: UTXO[];
  selectedAddresses: string[];
  selectedContractAddresses: string[];
  totalSelectedUtxoAmount: bigint;
  handleUtxoClick: (utxo: UTXO) => void;
  currentNetwork: Network;
}

// ---- BigInt-safe formatting helpers ----
const SATS_PER_BCH = 100_000_000n;

function toBigIntSats(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function formatSatsToBchString(satsLike: bigint | number): string {
  const sats =
    typeof satsLike === 'bigint' ? satsLike : BigInt(Math.trunc(satsLike));
  const sign = sats < 0n ? '-' : '';
  const abs = sats < 0n ? -sats : sats;

  const whole = abs / SATS_PER_BCH;
  const frac = abs % SATS_PER_BCH;

  const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '');

  return sign + whole.toString() + (fracStr ? `.${fracStr}` : '');
}

function pow10BigInt(decimals: number): bigint {
  // decimals are typically small (0-18). Keep it simple.
  let x = 1n;
  for (let i = 0; i < decimals; i++) x *= 10n;
  return x;
}

// Token amount formatter that supports number | bigint + decimals
function formatTokenAmount(
  amount: number | string | bigint,
  decimals: number = 0
): string {
  if (decimals <= 0) return String(amount);

  // Prefer bigint math when possible
  if (typeof amount === 'bigint') {
    const base = pow10BigInt(decimals);
    const sign = amount < 0n ? '-' : '';
    const abs = amount < 0n ? -amount : amount;

    const whole = abs / base;
    const frac = abs % base;

    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');

    return sign + whole.toString() + (fracStr ? `.${fracStr}` : '');
  }

  // Fallback to number formatting
  const numAmount =
    typeof amount === 'string' ? parseFloat(amount) : Number(amount);
  if (!Number.isFinite(numAmount)) return '0';

  const divisor = Math.pow(10, decimals);
  const formatted = (numAmount / divisor).toFixed(decimals);
  return formatted.replace(/\.?0+$/, '');
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

  const prices = useSelector((s: RootState) => s.priceFeed);
  const bchUsd = prices['BCH-USD']?.price ?? 0;

  // Fetch token metadata when categories change
  useEffect(() => {
    const svc = new BcmrService();
    const missing = Array.from(
      new Set(
        selectedUtxos
          .map((u) => u.token?.category)
          .filter((c): c is string => !!c && !(c in tokenMetadata))
      )
    );

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

          const decimals = snap.token?.decimals || 0;
          const symbol = snap.token?.symbol || '';
          newMeta[category] = { name: snap.name, symbol, decimals, iconUri };
        } catch (e) {
          // ignore
        }
      }
      if (Object.keys(newMeta).length > 0) {
        setTokenMetadata((prev) => ({ ...prev, ...newMeta }));
      }
    })();
  }, [selectedUtxos, tokenMetadata]);

  const togglePopup = () => setShowPopup((v) => !v);

  // Total BCH string (BigInt-safe)
  const totalBchStr = formatSatsToBchString(totalSelectedUtxoAmount);
  const totalBchNum = parseFloat(totalBchStr);
  const totalUsd = Number.isFinite(totalBchNum)
    ? (totalBchNum * bchUsd).toFixed(2)
    : '0.00';

  return (
    <div className="mb-4">
      {selectedUtxos.length > 0 ? (
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold ">Transaction Inputs</h3>
          <button
            onClick={togglePopup}
            className="wallet-btn-primary font-bold py-1 px-2"
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
                const isToken = !!utxo.token;
                const cat = utxo.token?.category;
                const meta = cat ? tokenMetadata[cat] : null;

                // BigInt-safe sats (handles contract UTXOs that may use bigint)
                const sats = toBigIntSats(utxo.amount ?? utxo.value);

                return (
                  <button
                    key={key}
                    onClick={() => handleUtxoClick(utxo)}
                    className="flex flex-col items-start mb-2 w-full break-words whitespace-normal border border-[var(--wallet-border)] p-2 rounded wallet-surface-strong"
                  >
                    {/* Address */}
                    <span className="w-full">
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
                          {formatSatsToBchString(sats)} BCH
                        </span>
                        <span className="w-full">
                          Tx Hash: {shortenTxHash(utxo.tx_hash)}
                        </span>
                      </>
                    )}

                    {/* Contract Function */}
                    {utxo.contractFunction && (
                      <span className="w-full">
                        Contract Function: {utxo.contractFunction}
                      </span>
                    )}
                    {!utxo.unlocker && utxo.abi && (
                      <span className="wallet-danger-text w-full">
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
                            <FaBitcoin className="wallet-accent-icon text-3xl mr-2" />
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
          <h3 className="flex flex-col">
            <span>
              {`${selectedUtxos.length} Input${selectedUtxos.length === 1 ? '' : 's'} - ${totalBchStr} BCH`}
            </span>
            <span>{`$ ${totalUsd} USD`}</span>
          </h3>
        </div>
      )}
    </div>
  );
}
