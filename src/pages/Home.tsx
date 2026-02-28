// src/pages/Home.tsx

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
// import { LocalNotifications } from '@capacitor/local-notifications';
import { AppDispatch, RootState } from '../redux/store';
import BitcoinCashCard from '../components/BitcoinCashCard';
import CashTokenCard from '../components/CashTokenCard';
import UTXOService from '../services/UTXOService';
import {
  // setUTXOs,
  setFetchingUTXOs,
  setInitialized,
  replaceAllUTXOs,
} from '../redux/utxoSlice';
import PriceFeed from '../components/PriceFeed';
import { TailSpin } from 'react-loader-spinner';
import Popup from '../components/transaction/Popup';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { primeUTXOCache } from '../services/ElectrumService';
import { UTXO } from '../types/types';
import { logError } from '../utils/errorHandling';
import { useHomeSubscriptions } from './home/useHomeSubscriptions';
import { useHomeKeys } from './home/useHomeKeys';
import { useHomePlaceholderState } from './home/useHomePlaceholderState';
import { useHomeMetadataPreload } from './home/useHomeMetadataPreload';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import EmptyState from '../components/ui/EmptyState';
import StatusChip from '../components/ui/StatusChip';

const USE_HOME_SUBS = false;

const Home: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch<AppDispatch>();
  const dbService = useMemo(() => DatabaseService(), []);

  // Redux selectors
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const reduxUTXOs = useSelector((state: RootState) => state.utxos.utxos);
  const fetchingUTXOsRedux = useSelector(
    (state: RootState) => state.utxos.fetchingUTXOs
  );
  const IsInitialized = useSelector(
    (state: RootState) => state.utxos.initialized
  );
  const userBalance = useSelector(
    (state: RootState) => state.utxos.totalBalance
  );

  // Local state
  const { keyPairs, generatingKeys, handleGenerateKeys } = useHomeKeys({
    currentWalletId,
  });
  const {
    setPlaceholderUTXOs,
    placeholderBalance,
    placeholderTokenTotals,
  } = useHomePlaceholderState({
    reduxUTXOs,
    fetchingUTXOsRedux,
  });
  const [showCashTokenPopup, setShowCashTokenPopup] = useState(false);

  const hasFetchedForTx = useRef(false);
  useHomeSubscriptions({
    enabled: USE_HOME_SUBS,
    isInitialized: IsInitialized,
    fetchingUTXOs: fetchingUTXOsRedux,
    keyPairs,
    currentWalletId,
    reduxUTXOs,
    dispatch,
  });

  // Fetch and store UTXOs
  const fetchAndStoreUTXOs = useCallback(async () => {
    if (fetchingUTXOsRedux || !currentWalletId || keyPairs.length === 0) return;

    dispatch(setFetchingUTXOs(true));
    const allUTXOs: Record<string, UTXO[]> = {};

    try {
      const fetchResults = await Promise.allSettled(
        keyPairs.map(async (keyPair) => ({
          address: keyPair.address,
          utxos: await UTXOService.fetchAndStoreUTXOs(
            currentWalletId,
            keyPair.address
          ),
        }))
      );

      for (const result of fetchResults) {
        if (result.status === 'fulfilled') {
          allUTXOs[result.value.address] = result.value.utxos;
        } else {
          logError('Home.fetchAndStoreUTXOs.address', result.reason);
        }
      }

      for (const [addr, list] of Object.entries(allUTXOs)) {
        primeUTXOCache(addr, list);
      }

      setPlaceholderUTXOs(allUTXOs);
      dispatch(replaceAllUTXOs({ utxosByAddress: allUTXOs }));
      await dbService.saveDatabaseToFile();
      dispatch(setInitialized(true));
    } catch (error) {
      logError('Home.fetchAndStoreUTXOs', error, {
        walletId: currentWalletId,
      });
    } finally {
      dispatch(setFetchingUTXOs(false));
    }
  }, [
    keyPairs,
    fetchingUTXOsRedux,
    currentWalletId,
    dispatch,
    setPlaceholderUTXOs,
    dbService,
  ]);

  // Fetch UTXOs when keys are available and not initialized
  useEffect(() => {
    if (keyPairs.length > 0 && !IsInitialized) {
      fetchAndStoreUTXOs();
    }
  }, [keyPairs, IsInitialized, fetchAndStoreUTXOs]);

  // Handle post-transaction UTXO refresh
  useEffect(() => {
    const fromTxSuccess = location?.state?.fromTxSuccess;
    if (fromTxSuccess && keyPairs.length > 0 && !hasFetchedForTx.current) {
      fetchAndStoreUTXOs();
      hasFetchedForTx.current = true;
    }
  }, [location, keyPairs, fetchAndStoreUTXOs]);

  useHomeMetadataPreload({
    isInitialized: IsInitialized,
    placeholderTokenTotals,
  });

  const compareAmountDesc = (a: bigint, b: bigint): number => {
    if (a === b) return 0;
    return a > b ? -1 : 1;
  };

  const fungibleTokens = Object.entries(placeholderTokenTotals)
    .filter(([, { amount }]) => amount > 0n)
    .sort((a, b) => compareAmountDesc(a[1].amount, b[1].amount));
  const nonFungibleTokens = Object.entries(placeholderTokenTotals)
    .filter(([, { amount }]) => amount <= 0n)
    .sort((a, b) => compareAmountDesc(a[1].amount, b[1].amount));

  const displayBalance = fetchingUTXOsRedux ? placeholderBalance : userBalance;
  const nextAddressIndex = useMemo(() => {
    if (keyPairs.length === 0) return 0;
    return Math.max(...keyPairs.map((keyPair) => keyPair.addressIndex)) + 1;
  }, [keyPairs]);

  return (
    <div className="container mx-auto max-w-md p-4 pb-16 wallet-page">
      <PageHeader title="Home" subtitle="Wallet overview" compact />
      <PriceFeed />

      <SectionCard className="mt-3">
        {(fetchingUTXOsRedux || generatingKeys) && (
          <div className="mb-3 flex items-center justify-center">
            <StatusChip tone="neutral">
              {fetchingUTXOsRedux ? 'Refreshing wallet data...' : 'Generating new key...'}
            </StatusChip>
          </div>
        )}
        <div className="flex flex-col items-center gap-3">
        <button
            className="wallet-btn-secondary w-full max-w-md"
          onClick={() => navigate('/contract')}
        >
          Contracts
        </button>
        <button
            className="wallet-btn-primary w-full max-w-md"
          onClick={() => navigate('/apps')}
        >
          Apps
        </button>
        <button
            className="wallet-btn-primary flex justify-center items-center w-full max-w-md"
          onClick={fetchAndStoreUTXOs}
          disabled={fetchingUTXOsRedux || generatingKeys}
        >
          {fetchingUTXOsRedux === false ? (
            `Fetch UTXOs`
          ) : (
            <div className="flex justify-center items-center w-full">
              <TailSpin
                visible={true}
                height="24"
                width="24"
                color="white"
                ariaLabel="tail-spin-loading"
                radius="1"
              />
            </div>
          )}
        </button>
        <button
            className="wallet-btn-primary w-full max-w-md"
          onClick={() =>
            handleGenerateKeys(nextAddressIndex)
          }
          disabled={fetchingUTXOsRedux || generatingKeys}
        >
          Generate New Key
        </button>
        </div>
      </SectionCard>

      <div className="w-full max-w-md mx-auto mt-4 flex items-center justify-center">
        <BitcoinCashCard totalAmount={displayBalance} />{' '}
      </div>

      <div className="w-full max-w-full mx-auto mt-4 flex justify-center">
        <button
          onClick={() => setShowCashTokenPopup(true)}
          className="wallet-btn-primary w-full max-w-md mt-4 mx-auto"
        >
          Show CashTokens
        </button>
      </div>

      {showCashTokenPopup && (
        <Popup closePopups={() => setShowCashTokenPopup(false)}>
          <h3 className="text-xl flex flex-col items-center font-bold mb-4">
            Cash Tokens
          </h3>
          <div className="max-h-[50vh] overflow-y-auto">
            {fungibleTokens.length > 0 && (
              <div className="mb-2">
                <h4 className="text-lg font-semibold flex flex-col items-center mb-2">
                  Fungible Tokens
                </h4>
                <div className="flex flex-col">
                  {fungibleTokens.map(([category, { amount, decimals }]) => (
                    <CashTokenCard
                      key={category}
                      category={category}
                      totalAmount={amount}
                      decimals={decimals}
                    />
                  ))}
                </div>
              </div>
            )}
            {nonFungibleTokens.length > 0 && (
              <div className="mb-2">
                <h4 className="text-lg font-semibold flex flex-col items-center mb-2">
                  Non-Fungible Tokens
                </h4>
                <div className="flex flex-col">
                  {nonFungibleTokens.map(([category, { amount, decimals }]) => (
                    <CashTokenCard
                      key={category}
                      category={category}
                      totalAmount={amount}
                      decimals={decimals}
                    />
                  ))}
                </div>
              </div>
            )}
            {fungibleTokens.length === 0 && nonFungibleTokens.length === 0 && (
              <EmptyState message="No CashTokens available." />
            )}
          </div>
        </Popup>
      )}
    </div>
  );
};

export default Home;
