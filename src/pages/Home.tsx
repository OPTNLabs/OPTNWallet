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
import WalkthroughPanel from '../components/ui/WalkthroughPanel';
import { refreshUTXOWorkerSubscriptions } from '../workers/UTXOWorkerService';
import { logError } from '../utils/errorHandling';
import { runWalletUtxoRefresh } from '../services/RefreshCoordinator';
import { Network } from '../redux/networkSlice';
import QuantumrootPortfolioService from '../services/QuantumrootPortfolioService';
import QuantumrootTrackingService from '../services/QuantumrootTrackingService';

const USE_HOME_SUBS = false;
const HOME_WALKTHROUGH_STORAGE_KEY = 'hasSeenHomeWalkthroughV2';

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

  const currentNetwork = useSelector(
    (state: RootState) => state.network.currentNetwork
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
  const [showOnboardingHint, setShowOnboardingHint] = useState(false);

  useEffect(() => {
    const hasSeenHint = localStorage.getItem(HOME_WALKTHROUGH_STORAGE_KEY);
    if (!hasSeenHint) {
      setShowOnboardingHint(true);
    }
  }, []);

  const dismissOnboardingHint = () => {
    setShowOnboardingHint(false);
    localStorage.setItem(HOME_WALKTHROUGH_STORAGE_KEY, 'true');
  };
  const [quantumrootBalance, setQuantumrootBalance] = useState(0);
  const [quantumrootVaultCount, setQuantumrootVaultCount] = useState(0);

  const refreshQuantumrootPortfolio = useCallback(async () => {
    if (!currentWalletId) {
      setQuantumrootBalance(0);
      setQuantumrootVaultCount(0);
      return;
    }

    try {
      const summary =
        await QuantumrootPortfolioService.summarizeWallet(currentWalletId);
      setQuantumrootBalance(summary.quantumrootBalanceSats);
      setQuantumrootVaultCount(summary.vaultCount);
    } catch (error) {
      logError('Home.refreshQuantumrootPortfolio', error, {
        walletId: currentWalletId,
      });
    }
  }, [currentWalletId]);

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
        const quantumrootAddresses =
          await QuantumrootTrackingService.listTrackedAddresses(
            currentWalletId
          );
        const fetchedQuantumrootByAddress =
          await UTXOService.fetchAndStoreUTXOsMany(
            currentWalletId,
            quantumrootAddresses
          );

        for (const keyPair of keyPairs) {
          allUTXOs[keyPair.address] = fetchedByAddress[keyPair.address] ?? [];
        }
        for (const address of quantumrootAddresses) {
          allUTXOs[address] = fetchedQuantumrootByAddress[address] ?? [];
        }

        for (const [addr, list] of Object.entries(allUTXOs)) {
          primeUTXOCache(addr, list);
        }

        dispatch(replaceAllUTXOs({ utxosByAddress: allUTXOs }));
        await refreshQuantumrootPortfolio();
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
  }, [
    currentWalletId,
    dbService,
    dispatch,
    fetchingUTXOsRedux,
    keyPairs,
    refreshQuantumrootPortfolio,
  ]);

  useEffect(() => {
    if (keyPairs.length > 0 && currentWalletId) {
      void refreshUTXOWorkerSubscriptions();
    }
  }, [keyPairs, currentWalletId]);

  useEffect(() => {
    void refreshQuantumrootPortfolio();
  }, [refreshQuantumrootPortfolio]);

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
    <div className="container mx-auto max-w-md h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] px-4 pt-4 pb-[calc(var(--safe-bottom)+1rem)] flex flex-col overflow-hidden wallet-page">
      <PageHeader
        title="Home"
        subtitle={currentNetwork === Network.CHIPNET ? 'Chipnet' : ''}
        compact
      />
      <div className="flex-1 min-h-0 overflow-y-auto pr-1">
      <PriceFeed />

      <SectionCard className="mt-3">
        <div className="flex flex-col items-center gap-3">
          <div className="grid w-full max-w-md grid-cols-2 gap-3">
            <button
              className="wallet-btn-secondary w-full"
              onClick={() => navigate('/contract')}
            >
              Contracts
            </button>
            <button
              className="wallet-btn-primary w-full"
              onClick={() => navigate('/apps')}
            >
              Apps
            </button>
          </div>
          <button
            className="wallet-btn-secondary w-full max-w-md"
            onClick={() => navigate('/quantumroot')}
          >
            Quantumroot Vaults
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
        <BitcoinCashCard
          totalAmount={displayBalance}
          quantumrootAmount={quantumrootBalance}
          quantumrootVaultCount={quantumrootVaultCount}
        />
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

      {showOnboardingHint && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="w-full max-w-md mx-4">
            <WalkthroughPanel
              title="How your wallet works"
              description="This home screen is your control center. Use it to create receiving addresses, refresh wallet data, and inspect balances before you send or receive funds."
              steps={[
                {
                  title: 'New Address',
                  description:
                    'Creates a fresh receive address so you can share it without reusing older ones.',
                },
                {
                  title: 'Sync',
                  description:
                    'Refreshes your wallet history, balances, and pending outgoing transactions.',
                },
                {
                  title: 'Show CashTokens',
                  description:
                    'Opens a token summary so you can review fungible and non-fungible holdings.',
                },
              ]}
            />
            <button
              onClick={dismissOnboardingHint}
              className="wallet-btn-primary w-full mt-4"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Home;
