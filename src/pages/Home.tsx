// src/pages/Home.tsx

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
// import { LocalNotifications } from '@capacitor/local-notifications';
import { AppDispatch, RootState } from '../redux/store';
import BitcoinCashCard from '../components/BitcoinCashCard';
import CashTokenCard from '../components/CashTokenCard';
import PriceFeed from '../components/PriceFeed';
import Popup from '../components/transaction/Popup';
import UTXOService from '../services/UTXOService';
import {
  setFetchingUTXOs,
  replaceAllUTXOs,
  setInitialized,
} from '../redux/utxoSlice';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import ElectrumService, { primeUTXOCache } from '../services/ElectrumService';
import { UTXO } from '../types/types';
import { useHomeSubscriptions } from './home/useHomeSubscriptions';
import { useHomeKeys } from './home/useHomeKeys';
import { useHomePlaceholderState } from './home/useHomePlaceholderState';
import { useHomeMetadataPreload } from './home/useHomeMetadataPreload';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import EmptyState from '../components/ui/EmptyState';
import { refreshUTXOWorkerSubscriptions } from '../workers/UTXOWorkerService';
import { logError } from '../utils/errorHandling';
import { runWalletUtxoRefresh } from '../services/RefreshCoordinator';

const USE_HOME_SUBS = false;

const Home: React.FC = () => {
  const navigate = useNavigate();
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
  const { placeholderBalance, placeholderTokenTotals } =
    useHomePlaceholderState({
      reduxUTXOs,
      fetchingUTXOsRedux,
    });
  const [showCashTokenPopup, setShowCashTokenPopup] = useState(false);

  useHomeSubscriptions({
    enabled: USE_HOME_SUBS,
    isInitialized: IsInitialized,
    fetchingUTXOs: fetchingUTXOsRedux,
    keyPairs,
    currentWalletId,
    reduxUTXOs,
    dispatch,
  });

  const handleRefresh = useCallback(async () => {
    if (fetchingUTXOsRedux || !currentWalletId || keyPairs.length === 0) return;

    dispatch(setFetchingUTXOs(true));
    const allUTXOs: Record<string, UTXO[]> = {};

    try {
      await runWalletUtxoRefresh(currentWalletId, async () => {
        await ElectrumService.reconnect();

        const fetchedByAddress = await UTXOService.fetchAndStoreUTXOsMany(
          currentWalletId,
          keyPairs.map((keyPair) => keyPair.address)
        );

        for (const keyPair of keyPairs) {
          allUTXOs[keyPair.address] = fetchedByAddress[keyPair.address] ?? [];
        }

        for (const [addr, list] of Object.entries(allUTXOs)) {
          primeUTXOCache(addr, list);
        }

        dispatch(replaceAllUTXOs({ utxosByAddress: allUTXOs }));
        dbService.scheduleDatabaseSave();
        dispatch(setInitialized(true));
        await refreshUTXOWorkerSubscriptions();
      });
    } catch (error) {
      logError('Home.handleRefresh', error, {
        walletId: currentWalletId,
      });
    } finally {
      dispatch(setFetchingUTXOs(false));
    }
  }, [currentWalletId, dbService, dispatch, fetchingUTXOsRedux, keyPairs]);

  useEffect(() => {
    if (keyPairs.length > 0 && currentWalletId) {
      void refreshUTXOWorkerSubscriptions();
    }
  }, [keyPairs, currentWalletId]);

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
      <PageHeader title="Home" compact />
      <PriceFeed />

      <SectionCard className="mt-3">
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
          <div className="grid w-full max-w-md grid-cols-10 gap-3">
            <button
              className="wallet-btn-primary col-span-8 w-full"
              onClick={() => handleGenerateKeys(nextAddressIndex)}
              disabled={fetchingUTXOsRedux || generatingKeys}
            >
              New Address
            </button>
            <button
              className="wallet-btn-secondary col-span-2 w-full"
              onClick={handleRefresh}
              disabled={fetchingUTXOsRedux || generatingKeys}
            >
              {fetchingUTXOsRedux ? (
                <span className="flex items-center justify-center">
                  <span className="wallet-spinner" aria-hidden="true" />
                </span>
              ) : (
                'Sync'
              )}
            </button>
          </div>
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
