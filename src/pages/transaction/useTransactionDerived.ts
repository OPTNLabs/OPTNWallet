import { useMemo } from 'react';
import { PriceFeedState } from '../../redux/priceFeedSlice';
import { UTXO } from '../../types/types';
import { SATSINBITCOIN } from '../../utils/constants';
import {
  getFilteredCashTokenUTXOs,
  getFilteredContractUTXOs,
  getFilteredRegularUTXOs,
  getTotalSelectedUtxoAmount,
} from './derivations';

type UseTransactionDerivedParams = {
  utxosByAddress: Record<string, UTXO[]>;
  contractUTXOs: UTXO[];
  selectedAddresses: string[];
  selectedContractAddresses: string[];
  selectedUtxos: UTXO[];
  bytecodeSize: number;
  rawTX: string;
  prices: PriceFeedState;
};

export function useTransactionDerived({
  utxosByAddress,
  contractUTXOs,
  selectedAddresses,
  selectedContractAddresses,
  selectedUtxos,
  bytecodeSize,
  rawTX,
  prices,
}: UseTransactionDerivedParams) {
  const utxos = useMemo(() => Object.values(utxosByAddress).flat(), [utxosByAddress]);

  const filteredRegularUTXOs = useMemo(
    () => getFilteredRegularUTXOs(utxos, selectedAddresses),
    [utxos, selectedAddresses]
  );

  const filteredCashTokenUTXOs = useMemo(
    () => getFilteredCashTokenUTXOs(utxos, selectedAddresses),
    [utxos, selectedAddresses]
  );

  const filteredContractUTXOs = useMemo(
    () => getFilteredContractUTXOs(contractUTXOs, selectedContractAddresses),
    [contractUTXOs, selectedContractAddresses]
  );

  const totalSelectedUtxoAmount = useMemo(
    () => getTotalSelectedUtxoAmount(selectedUtxos),
    [selectedUtxos]
  );

  const feeBch = useMemo(() => bytecodeSize / SATSINBITCOIN, [bytecodeSize]);
  const bchUsd = prices?.['BCH-USD']?.price;
  const hasPrice = typeof bchUsd === 'number' && Number.isFinite(bchUsd);
  const feeUsdLabel = useMemo(() => {
    if (!hasPrice) return 'USD price unavailable';
    const feeUsd = feeBch * (bchUsd as number);
    return feeUsd < 1
      ? `¢ ${(feeUsd * 100).toFixed(2)} cents USD`
      : `$ ${feeUsd.toFixed(2)} USD`;
  }, [bchUsd, feeBch, hasPrice]);

  const showFee = Number.isFinite(bytecodeSize) && bytecodeSize > 0 && rawTX !== '';

  return {
    utxos,
    filteredRegularUTXOs,
    filteredCashTokenUTXOs,
    filteredContractUTXOs,
    totalSelectedUtxoAmount,
    showFee,
    feeBch,
    feeUsdLabel,
  };
}
