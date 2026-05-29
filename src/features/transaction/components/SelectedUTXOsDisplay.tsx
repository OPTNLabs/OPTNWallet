// src/components/transaction/SelectedUTXOsDisplay.tsx
import { useState } from 'react';
import { FaBitcoin } from 'react-icons/fa';
import { UTXO } from '../../../types/types';
import Popup from './Popup';
import { shortenTxHash } from '../../../utils/shortenHash';
import { PREFIX } from '../../../utils/constants';
import { Network } from '../../../state/slices/networkSlice';
import { useSelector } from 'react-redux';
import { RootState } from '../../../state/store';
import useSharedTokenMetadata from '../../../hooks/useSharedTokenMetadata';
import TokenIdentityBadge from '../../../components/ui/TokenIdentityBadge';
import {
  formatAtomicTokenAmount,
  resolveTokenPresentation,
} from '../../../utils/tokenPresentation';

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

export default function SelectedUTXOsDisplay({
  selectedUtxos,
  selectedAddresses,
  selectedContractAddresses,
  totalSelectedUtxoAmount,
  handleUtxoClick,
  currentNetwork,
}: SelectedUTXOsDisplayProps) {
  const [showPopup, setShowPopup] = useState(false);
  const tokenMetadata = useSharedTokenMetadata(
    selectedUtxos
      .map((u) => u.token?.category)
      .filter((c): c is string => !!c)
  );

  const prices = useSelector((s: RootState) => s.priceFeed);
  const bchUsd = prices['BCH-USD']?.price ?? 0;

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
          <div>
            <h3 className="text-lg font-semibold">Selected funds</h3>
          </div>
          <button
            onClick={togglePopup}
            className="wallet-btn-primary font-bold py-1 px-2"
          >
            Review funds
          </button>
        </div>
      ) : selectedAddresses.length > 0 ||
        selectedContractAddresses.length > 0 ? (
        <div className="text-sm wallet-muted">
          No funds selected yet.
        </div>
      ) : (
        <></>
      )}

      {showPopup && (
        <Popup closePopups={() => setShowPopup(false)}>
          <h3 className="text-lg font-semibold text-center mb-4">
            Selected funds
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
                const fallback = utxo.token?.BcmrTokenMetadata
                  ? {
                      name: utxo.token.BcmrTokenMetadata.name,
                      symbol: utxo.token.BcmrTokenMetadata.token.symbol,
                      decimals: utxo.token.BcmrTokenMetadata.token.decimals,
                      iconUri:
                        utxo.token.BcmrTokenMetadata.uris?.icon ?? null,
                    }
                  : null;
                const presentation = resolveTokenPresentation(
                  cat ?? '',
                  meta,
                  fallback
                );

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
                        {formatAtomicTokenAmount(
                          utxo.token!.amount,
                          presentation.decimals
                        )}{' '}
                        {presentation.symbol || 'tokens'}
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
                      {isToken ? (
                        <TokenIdentityBadge
                          presentation={presentation}
                          className="w-full"
                          avatarClassName="h-6 w-6"
                          primaryClassName="text-sm"
                          secondaryClassName="text-[11px]"
                          detail={
                            <span className="text-sm font-medium wallet-muted">
                              {utxo.token?.nft ? 'NFT' : 'FT'}
                            </span>
                          }
                        />
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
              {`${selectedUtxos.length} selected item${selectedUtxos.length === 1 ? '' : 's'} - ${totalBchStr} BCH`}
            </span>
            <span>{`$ ${totalUsd} USD`}</span>
          </h3>
        </div>
      )}
    </div>
  );
}
