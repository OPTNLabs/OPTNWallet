// src/pages/Home.tsx

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { LocalNotifications } from '@capacitor/local-notifications';
import { RootState } from '../redux/store';
import BitcoinCashCard from '../components/BitcoinCashCard';
import CashTokenCard from '../components/CashTokenCard';
import KeyService from '../services/KeyService';
import UTXOService from '../services/UTXOService';
import {
  // setUTXOs,
  setFetchingUTXOs,
  setInitialized,
  updateUTXOsForAddress,
  replaceAllUTXOs
} from '../redux/utxoSlice';
import PriceFeed from '../components/PriceFeed';
import { TailSpin } from 'react-loader-spinner';
import Popup from '../components/transaction/Popup';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import BcmrService from '../services/BcmrService';
import ElectrumService, { primeUTXOCache } from '../services/ElectrumService';
// import BlockHeaderDisplay from '../components/blockheader';

const USE_HOME_SUBS = false;
const __subscribedAddresses = new Set<string>();

const batchAmount = 10;

const Home: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch();

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
  const [keyPairs, setKeyPairs] = useState<any[]>([]);
  const [generatingKeys, setGeneratingKeys] = useState(false);
  const [placeholderUTXOs, setPlaceholderUTXOs] = useState<
    Record<string, any[]>
  >(Object.keys(reduxUTXOs).length > 0 ? reduxUTXOs : {});
  const [placeholderBalance, setPlaceholderBalance] = useState(0);
  const [placeholderTokenTotals, setPlaceholderTokenTotals] = useState<
    Record<string, { amount: number; decimals: number }>
  >({});
  const [showCashTokenPopup, setShowCashTokenPopup] = useState(false);
  const [metadataPreloaded, setMetadataPreloaded] = useState(false);

  const headersSubDone = useRef(false);

  const hasFetchedForTx = useRef(false);

  const headerRefreshScheduled = useRef(false);
  const runHeaderRefresh = useCallback((addrs: string[]) => {
    if (headerRefreshScheduled.current) return;       // collapse bursts
    headerRefreshScheduled.current = true;
    setTimeout(async () => {
      for (const addr of addrs) {
        try {
          const utxos = await ElectrumService.getUTXOs(addr);
          dispatch(updateUTXOsForAddress({ address: addr, utxos }));
        } catch (e) {
          console.error('UTXO refresh on new block failed for', addr, e);
        }
      }
      try { await DatabaseService().saveDatabaseToFile(); } catch {}
      headerRefreshScheduled.current = false;
    }, 750);
  }, [dispatch]);

  // Keep latest UTXOs in a ref to compare inside async callbacks (avoid stale closures)
  const utxosRef = useRef(reduxUTXOs);
  useEffect(() => {
    utxosRef.current = reduxUTXOs;
  }, [reduxUTXOs]);

  // Calculate balance from UTXOs
  const calculateBalance = (utxos: Record<string, any[]>) => {
    return Object.values(utxos)
      .flat()
      .reduce((total, utxo) => total + (utxo.value || 0), 0);
  };

  // Calculate token totals from UTXOs
  const calculateCashTokenTotals = (utxos: Record<string, any[]>) => {
    const tokenTotals: Record<string, { amount: number; decimals: number }> =
      {};
    Object.values(utxos)
      .flat()
      .forEach((utxo) => {
        const { category, amount, BcmrTokenMetadata } = utxo.token || {};
        if (category) {
          const parsedAmount = parseFloat(amount || '0');
          const decimals = BcmrTokenMetadata?.token?.decimals ?? 0;
          if (tokenTotals[category]) {
            tokenTotals[category].amount += parsedAmount;
          } else {
            tokenTotals[category] = { amount: parsedAmount, decimals };
          }
        }
      });
    return tokenTotals;
  };

  useEffect(() => {
    console.log('[Home] fetchingUTXOsRedux=', fetchingUTXOsRedux, 'IsInitialized=', IsInitialized);
  }, [fetchingUTXOsRedux, IsInitialized]);

  useEffect(() => {
    console.log('[Home] userBalance (redux)=', userBalance, 'utxo keys=', Object.keys(reduxUTXOs));
  }, [userBalance, reduxUTXOs]);

  useEffect(() => {
    console.log('[Home] placeholderBalance (local)=', placeholderBalance);
  }, [placeholderBalance]);

  // Update balance and token totals when placeholderUTXOs changes
  useEffect(() => {
    const balance = calculateBalance(placeholderUTXOs);
    setPlaceholderBalance(balance);
    setPlaceholderTokenTotals(calculateCashTokenTotals(placeholderUTXOs));
  }, [placeholderUTXOs]);

  // Sync placeholderUTXOs with reduxUTXOs when not fetching
  useEffect(() => {
    if (!fetchingUTXOsRedux && Object.keys(reduxUTXOs).length > 0) {
      setPlaceholderUTXOs(reduxUTXOs);
    }
  }, [fetchingUTXOsRedux, reduxUTXOs]);

  // Generate keys logic
  const generateKeys = useCallback(async () => {
    if (!currentWalletId || generatingKeys) return;

    setGeneratingKeys(true);
    const existingKeys = await KeyService.retrieveKeys(currentWalletId);

    if (existingKeys.length === 0) {
      const newKeys = [];
      const keySet = new Set(existingKeys.map((key: any) => key.address));

      for (let i = existingKeys.length; i < batchAmount; i++) {
        const newKey = await handleGenerateKeys(i);
        if (newKey && !keySet.has(newKey.address)) {
          newKeys.push(newKey);
          keySet.add(newKey.address);
        }
      }

      setKeyPairs((prevKeys) => [...prevKeys, ...newKeys]);
    } else {
      setKeyPairs(existingKeys);
    }

    setGeneratingKeys(false);
  }, [currentWalletId, generatingKeys]);

  // Fetch and store UTXOs
  const fetchAndStoreUTXOs = useCallback(async () => {
    if (fetchingUTXOsRedux || !currentWalletId || keyPairs.length === 0) return;

    dispatch(setFetchingUTXOs(true));
    const allUTXOs: Record<string, any[]> = {};

    try {
      for (const keyPair of keyPairs) {
        try {
          const fetchedUTXOs = await UTXOService.fetchAndStoreUTXOs(
            currentWalletId,
            keyPair.address
          );
          allUTXOs[keyPair.address] = fetchedUTXOs;
        } catch (error) {
          console.error(
            `Error fetching UTXOs for address ${keyPair.address}:`,
            error
          );
        }
      }

      for (const [addr, list] of Object.entries(allUTXOs)) {
        primeUTXOCache(addr, list);
      }

      setPlaceholderUTXOs(allUTXOs);
      dispatch(replaceAllUTXOs({ utxosByAddress: allUTXOs }));
      await DatabaseService().saveDatabaseToFile();
      dispatch(setInitialized(true));
    } catch (error) {
      console.error('Error fetching UTXOs:', error);
    } finally {
      dispatch(setFetchingUTXOs(false));
    }
  }, [keyPairs, fetchingUTXOsRedux, currentWalletId, dispatch]);

  // Load keys when wallet ID changes
  useEffect(() => {
    if (!currentWalletId) return;

    const loadKeys = async () => {
      const existingKeys = await KeyService.retrieveKeys(currentWalletId);
      setKeyPairs(existingKeys);
      if (existingKeys.length === 0) {
        await generateKeys();
      }
    };
    loadKeys();
  }, [currentWalletId, generateKeys]);

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

  // 🔔 helper to notify on newly-seen UTXOs (not on baseline/initial state)
  // const notifyNewUtxos = useCallback(
  //   async (address: string, oldSet: Set<string>, freshlyFetched: any[]) => {
  //     // const freshSet = new Set(
  //     //   freshlyFetched.map((u: any) => `${u.tx_hash}:${u.tx_pos}`)
  //     // );
  //     const newOnes = freshlyFetched.filter(
  //       (u: any) => !oldSet.has(`${u.tx_hash}:${u.tx_pos}`)
  //     );
  //     if (newOnes.length === 0) return;

  //     // One notification per UTXO (or you can batch them)
  //     for (const u of newOnes) {
  //       try {
  //         const id = Math.floor(Date.now() % 2147483647);
  //         await LocalNotifications.schedule({
  //           notifications: [
  //             {
  //               id,
  //               title: 'Funds received',
  //               body: `${u.value ?? 0} sats to ${address.slice(0, 10)}…`,
  //               channelId: 'utxo',
  //               extra: { address, txid: u.tx_hash, value: u.value ?? 0 },
  //             },
  //           ],
  //         });
  //       } catch (e) {
  //         console.warn('Local notification failed:', e);
  //       }
  //     }

  //     // Update the ref baseline for this address
  //     const baseline = new Map(Object.entries(utxosRef.current));
  //     baseline.set(address, freshlyFetched);
  //     utxosRef.current = Object.fromEntries(baseline.entries()) as any;
  //   },
  //   []
  // );

  // ---- Electrum subscriptions: headers + per-address status ----
  // We intentionally DO NOT unsubscribe on unmount so the app keeps listening.
  useEffect(() => {
    if (!USE_HOME_SUBS) return;
    if (!IsInitialized || fetchingUTXOsRedux || keyPairs.length === 0 || !currentWalletId) return;
    const addrs = keyPairs.map((k: any) => k.address).filter(Boolean);

    (async () => {
      try {
        if (!headersSubDone.current) {
          await ElectrumService.subscribeBlockHeaders((_h) => runHeaderRefresh(addrs));
          headersSubDone.current = true;
        }
      } catch (e) { console.error('subscribeBlockHeaders failed:', e); }
    })();

    (async () => {
      for (const addr of addrs) {
        if (__subscribedAddresses.has(addr)) continue;
        __subscribedAddresses.add(addr);

        // Baseline only if Redux doesn’t already have UTXOs
        const already = Array.isArray(utxosRef.current?.[addr]) && utxosRef.current![addr].length > 0;
        if (!already) {
          try {
            const baseline = await ElectrumService.getUTXOs(addr);
            if (baseline.length > 0) { // <- don’t overwrite with []
              dispatch(updateUTXOsForAddress({ address: addr, utxos: baseline }));
              const m = new Map(Object.entries(utxosRef.current));
              m.set(addr, baseline);
              utxosRef.current = Object.fromEntries(m.entries()) as any;
            }
          } catch (e) {
            console.warn('Baseline UTXOs failed for', addr, e);
          }
        }

        try {
          await ElectrumService.subscribeAddress(addr, async (_status) => {
            try {
              const current = utxosRef.current?.[addr] ?? [];
              // const currentSet = new Set(current.map((u: any) => `${u.tx_hash}:${u.tx_pos}`));

              const utxos = await ElectrumService.getUTXOs(addr);

              // If fetch returned empty but we had non-empty, treat it as transient and skip
              if (utxos.length === 0 && current.length > 0) return;

              dispatch(updateUTXOsForAddress({ address: addr, utxos }));
              try { await DatabaseService().saveDatabaseToFile(); } catch {}

              // notify-new-utxos (optional)
              // await notifyNewUtxos(addr, currentSet, utxos);
            } catch (e) {
              console.error('subscribeAddress update failed for', addr, e);
            }
          });
        } catch (e) {
          console.error('subscribeAddress failed for', addr, e);
        }
      }
    })();
  }, [IsInitialized, fetchingUTXOsRedux, keyPairs, currentWalletId, dispatch, runHeaderRefresh]);


  // Preload token metadata
  useEffect(() => {
    if (!IsInitialized) return;
    (async () => {
      const bcmr = new BcmrService();
      const categories = Object.keys(placeholderTokenTotals);
      await Promise.all(
        categories.map(async (category) => {
          const authbase = await bcmr.getCategoryAuthbase(category);
          await bcmr.resolveIdentityRegistry(authbase);
        })
      );
      setMetadataPreloaded(true);
    })();
  }, [IsInitialized, placeholderTokenTotals]);

  // Save database when metadata is preloaded
  useEffect(() => {
    if (IsInitialized && metadataPreloaded) {
      DatabaseService().saveDatabaseToFile();
    }
  }, [IsInitialized, metadataPreloaded]);

  // Helper to generate new keys
  const handleGenerateKeys = async (index: number) => {
    if (!currentWalletId) return null;

    try {
      for (let i = 0; i < 2; i++) {
        await KeyService.createKeys(currentWalletId, 0, i, index);
        const newKeys = await KeyService.retrieveKeys(currentWalletId);
        const newKey = newKeys[newKeys.length - 1];

        if (newKey) {
          setKeyPairs((prevKeys) => [...prevKeys, newKey]);
        }
      }
    } catch (error) {
      console.error('Error generating new key:', error);
    }
  };

  const fungibleTokens = Object.entries(placeholderTokenTotals)
    .filter(([, { amount }]) => amount > 0)
    .sort((a, b) => b[1].amount - a[1].amount);
  const nonFungibleTokens = Object.entries(placeholderTokenTotals)
    .filter(([, { amount }]) => amount <= 0)
    .sort((a, b) => b[1].amount - a[1].amount);

  const displayBalance = fetchingUTXOsRedux ? placeholderBalance : userBalance;

  return (
    <div className="container mx-auto p-4 pb-16">
      {/* <BlockHeaderDisplay /> */}
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="w-3/4 h-auto"
        />
      </div>
      <PriceFeed />

      <div className="flex flex-col items-center py-3 space-y-4">
        <button
          className="mt-4 p-2 bg-red-500 font-bold text-white rounded hover:bg-red-600 transition duration-300 w-full max-w-md"
          onClick={() => navigate('/contract')}
        >
          Contracts
        </button>
        {/* <button
          className="mt-4 p-2 bg-green-500 font-bold text-white rounded hover:bg-green-600 transition duration-300 w-full max-w-md"
          onClick={() => navigate('/apps')}
        >
          Apps
        </button> */}
        <button
          className="flex justify-center items-center mt-4 p-2 bg-blue-500 font-bold text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md"
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
          className="mt-4 p-2 bg-blue-500 font-bold text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md"
          onClick={() =>
            handleGenerateKeys(
              Math.max(...keyPairs.map((keyPair) => keyPair.addressIndex)) + 1
            )
          }
          disabled={fetchingUTXOsRedux || generatingKeys}
        >
          Generate New Key
        </button>
      </div>

      <div className="w-full max-w-md mx-auto mt-4 flex items-center justify-center">
        <BitcoinCashCard totalAmount={displayBalance} />{' '}
      </div>

      <div className="w-full max-w-full mx-auto mt-4 flex justify-center">
        <button
          onClick={() => setShowCashTokenPopup(true)}
          className="w-full max-w-md bg-blue-500 hover:bg-blue-600 transition duration-300 font-bold text-white py-2 px-4 rounded mt-4 mx-auto"
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
              <p className="text-center text-gray-500">
                No CashTokens Available
              </p>
            )}
          </div>
        </Popup>
      )}
    </div>
  );
};

export default Home;
