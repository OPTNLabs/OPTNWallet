import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import BitcoinCashCard from '../components/BitcoinCashCard';
import CashTokenCard from '../components/CashTokenCard';
import KeyService from '../services/KeyService';
import UTXOService from '../services/UTXOService';
import { setUTXOs, setFetchingUTXOs, setInitialized } from '../redux/utxoSlice'; // Import setInitialized action
import Popup from '../components/Popup';
import PriceFeed from '../components/PriceFeed';
import { TailSpin } from 'react-loader-spinner';

const batchAmount = 10;

const initialUTXO: Record<string, any[]> = {
  default: [
    {
      wallet_id: 0,
      address: '',
      tokenAddress: '',
      height: 0,
      tx_hash: '',
      tx_pos: 0,
      value: 0,
      amount: 0,
      prefix: 'bchtest',
      token_data: null,
      privateKey: new Uint8Array(),
      contractName: '',
      abi: [],
      id: '',
      unlocker: null,
    },
  ],
};

const Home: React.FC = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
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
  const [keyPairs, setKeyPairs] = useState([]);
  const [generatingKeys, setGeneratingKeys] = useState(false);
  const [showPopup, setShowPopup] = useState(false);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [placeholderUTXOs, setPlaceholderUTXOs] = useState<
    Record<string, any[]>
  >(Object.keys(reduxUTXOs).length === 0 ? initialUTXO : reduxUTXOs); // Placeholder UTXOs to prevent UI flicker
  const [placeholderBalance, setPlaceholderBalance] = useState(0); // Placeholder balance for BitcoinCashCard
  const [placeholderTokenTotals, setPlaceholderTokenTotals] = useState<
    Record<string, number>
  >({}); // Placeholder token totals for CashTokenCard

  const initialized = useRef(false);

  const generateKeys = useCallback(async () => {
    if (!currentWalletId || generatingKeys) return;

    setGeneratingKeys(true);
    const existingKeys = await KeyService.retrieveKeys(currentWalletId);

    // If no keys exist, generate them
    if (existingKeys.length === 0) {
      const newKeys = [];
      const keySet = new Set(existingKeys.map((key) => key.address));

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

  const fetchAndStoreUTXOs = useCallback(async () => {
    if (fetchingUTXOsRedux || !currentWalletId) return;

    dispatch(setFetchingUTXOs(true));
    const allUTXOs: Record<string, any[]> = {};

    try {
      for (const keyPair of keyPairs) {
        setLoading((prev) => ({ ...prev, [keyPair.address]: true }));
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
        } finally {
          setLoading((prev) => ({ ...prev, [keyPair.address]: false }));
        }
      }

      // Set placeholder UTXOs to prevent UI flicker
      setPlaceholderUTXOs(allUTXOs);
      setPlaceholderBalance(calculateTotalBitcoinCash(allUTXOs));
      setPlaceholderTokenTotals(calculateCashTokenTotals(allUTXOs));

      // Update Redux store in a single batch after fetching all UTXOs
      dispatch(setUTXOs({ newUTXOs: allUTXOs }));

      // Set initialized to true after first successful fetch
      dispatch(setInitialized(true));
    } catch (error) {
      console.error('Error fetching UTXOs:', error);
    } finally {
      dispatch(setFetchingUTXOs(false));
    }
  }, [keyPairs, fetchingUTXOsRedux, currentWalletId, dispatch]);

  useEffect(() => {
    if (initialized.current || !currentWalletId) return;

    const initializeUTXOs = async () => {
      await generateKeys();
      if (Object.keys(placeholderUTXOs).length === 0) {
        await fetchAndStoreUTXOs();
      } else {
        setPlaceholderBalance(calculateTotalBitcoinCash(placeholderUTXOs));
        setPlaceholderTokenTotals(calculateCashTokenTotals(placeholderUTXOs));
      }
    };

    initializeUTXOs();
    initialized.current = true;
  }, [currentWalletId, generateKeys, placeholderUTXOs, fetchAndStoreUTXOs]);

  // Automatically start the initialization process if IsInitialized is false
  useEffect(() => {
    if (!IsInitialized && !fetchingUTXOsRedux && currentWalletId) {
      generateKeys().then(fetchAndStoreUTXOs);
    }
  }, [
    IsInitialized,
    fetchingUTXOsRedux,
    currentWalletId,
    generateKeys,
    fetchAndStoreUTXOs,
  ]);

  useEffect(() => {
    if (!fetchingUTXOsRedux) {
      setPlaceholderUTXOs(reduxUTXOs);
      setPlaceholderBalance(calculateTotalBitcoinCash(reduxUTXOs));
      setPlaceholderTokenTotals(calculateCashTokenTotals(reduxUTXOs));
    }
  }, [fetchingUTXOsRedux, reduxUTXOs]);

  const handleGenerateKeys = async (index: number) => {
    if (!currentWalletId) return null;

    try {
      // Create new key
      await KeyService.createKeys(currentWalletId, 0, 0, index);

      // Retrieve the newly created key only (instead of fetching all keys again)
      const newKeys = await KeyService.retrieveKeys(currentWalletId);
      const newKey = newKeys[newKeys.length - 1];

      if (newKey) {
        setKeyPairs((prevKeys) => [...prevKeys, newKey]);
      }
    } catch (error) {
      console.error('Error generating new key:', error);
    }
  };

  const togglePopup = () => setShowPopup(!showPopup);

  const calculateTotalBitcoinCash = (utxos: Record<string, any[]>) =>
    Object.values(utxos)
      .flat()
      .filter((utxo) => !utxo.token_data)
      .reduce((acc, utxo) => acc + utxo.amount, 0);

  const calculateCashTokenTotals = (utxos: Record<string, any[]>) => {
    const tokenTotals: Record<string, number> = {};
    Object.values(utxos)
      .flat()
      .forEach((utxo) => {
        const { category, amount } = utxo.token_data || {};
        if (category) {
          tokenTotals[category] =
            (tokenTotals[category] || 0) + parseFloat(amount);
        }
      });
    return tokenTotals;
  };

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
          className="mt-4 p-2 bg-red-500 text-white rounded hover:bg-red-600 transition duration-300 w-full max-w-md"
          onClick={() => navigate('/contract')}
        >
          Contracts
        </button>
        <button
          className="flex justify-center items-center mt-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md"
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
                color="white" // Match the spinner color with the button text color
                ariaLabel="tail-spin-loading"
                radius="1"
              />
            </div>
          )}
        </button>
        <button
          className="mt-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md"
          onClick={() => handleGenerateKeys(keyPairs.length)}
          disabled={fetchingUTXOsRedux || generatingKeys}
        >
          Generate New Key
        </button>
      </div>
      <div className="w-full max-w-md mx-auto mt-4 flex items-center justify-center">
        <BitcoinCashCard
          totalAmount={placeholderBalance}
          togglePopup={togglePopup}
        />
      </div>
      <div
        className="w-full max-w-full mx-auto mt-4 overflow-x-auto"
        style={{ maxHeight: '50vh' }}
      >
        <div className="flex space-x-4">
          {Object.entries(placeholderTokenTotals).map(([category, amount]) => (
            <div key={category}>
              <CashTokenCard
                key={category}
                category={category}
                totalAmount={amount}
              />
            </div>
          ))}
        </div>
      </div>

      {showPopup && (
        <Popup
          keyPairs={keyPairs}
          reduxUTXOs={placeholderUTXOs}
          loading={loading}
          togglePopup={togglePopup}
        />
      )}
    </div>
  );
};

export default Home;
