// src/pages/Home.tsx

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import BitcoinCashCard from '../components/BitcoinCashCard';
import CashTokenCard from '../components/CashTokenCard';
import KeyService from '../services/KeyService';
import UTXOService from '../services/UTXOService';
import { setUTXOs, setFetchingUTXOs, setInitialized } from '../redux/utxoSlice';
import PriceFeed from '../components/PriceFeed';
import { TailSpin } from 'react-loader-spinner';
import Popup from '../components/transaction/Popup';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import BcmrService from '../services/BcmrService';

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
  const totalBalance = useSelector(
    (state: RootState) => state.utxos.totalBalance
  );

  // Local state
  const [keyPairs, setKeyPairs] = useState<any[]>([]);
  const [generatingKeys, setGeneratingKeys] = useState(false);
  const [placeholderUTXOs, setPlaceholderUTXOs] = useState<
    Record<string, any[]>
  >(Object.keys(reduxUTXOs).length > 0 ? reduxUTXOs : {});
  const [placeholderBalance, setPlaceholderBalance] = useState(totalBalance);
  const [placeholderTokenTotals, setPlaceholderTokenTotals] = useState<
    Record<string, { amount: number; decimals: number }>
  >({});
  const [showCashTokenPopup, setShowCashTokenPopup] = useState(false);
  const [metadataPreloaded, setMetadataPreloaded] = useState(false);

  const hasFetchedForTx = useRef(false);

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
    if (fetchingUTXOsRedux || !currentWalletId) return;

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

      setPlaceholderUTXOs(allUTXOs);
      console.log(placeholderUTXOs);
      setPlaceholderTokenTotals(calculateCashTokenTotals(allUTXOs));
      dispatch(setUTXOs({ newUTXOs: allUTXOs }));
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

  // Sync placeholderBalance with totalBalance from Redux
  useEffect(() => {
    setPlaceholderBalance(totalBalance);
  }, [totalBalance]);

  // Handle post-transaction UTXO refresh
  useEffect(() => {
    const fromTxSuccess = location?.state?.fromTxSuccess;
    if (fromTxSuccess && keyPairs.length > 0 && !hasFetchedForTx.current) {
      fetchAndStoreUTXOs();
      hasFetchedForTx.current = true;
    }
  }, [location, keyPairs, fetchAndStoreUTXOs]);

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

  // Sync placeholder state with Redux UTXOs
  useEffect(() => {
    if (!fetchingUTXOsRedux && Object.keys(reduxUTXOs).length > 0) {
      setPlaceholderUTXOs(reduxUTXOs);
      setPlaceholderTokenTotals(calculateCashTokenTotals(reduxUTXOs));
    }
  }, [fetchingUTXOsRedux, reduxUTXOs]);

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

  // Calculate token totals
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

  const fungibleTokens = Object.entries(placeholderTokenTotals)
    .filter(([, { amount }]) => amount > 0)
    .sort((a, b) => b[1].amount - a[1].amount);
  const nonFungibleTokens = Object.entries(placeholderTokenTotals)
    .filter(([, { amount }]) => amount <= 0)
    .sort((a, b) => b[1].amount - a[1].amount);

  return (
    <div className="container mx-auto p-4 pb-16 mt-12">
      <PriceFeed />
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="max-w-full h-auto"
        />
      </div>

      <div className="flex flex-col items-center space-y-4">
        <button
          className="mt-4 p-2 bg-red-500 font-bold text-white rounded hover:bg-red-600 transition duration-300 w-full max-w-md"
          onClick={() => navigate('/contract')}
        >
          Contracts
        </button>
        <button
          className="mt-4 p-2 bg-green-500 font-bold text-white rounded hover:bg-green-600 transition duration-300 w-full max-w-md"
          onClick={() => navigate('/apps')}
        >
          Apps
        </button>
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
          onClick={() => handleGenerateKeys(keyPairs.length)}
          disabled={fetchingUTXOsRedux || generatingKeys}
        >
          Generate New Key
        </button>
      </div>

      <div className="w-full max-w-md mx-auto mt-4 flex items-center justify-center">
        <BitcoinCashCard totalAmount={placeholderBalance} />
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
          <h3 className="text-xl font-bold mb-4">Cash Tokens</h3>
          <div className="max-h-[50vh] overflow-y-auto">
            {fungibleTokens.length > 0 && (
              <div className="mb-2">
                <h4 className="text-lg font-semibold mb-2">Fungible Tokens</h4>
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
                <h4 className="text-lg font-semibold mb-2">
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
