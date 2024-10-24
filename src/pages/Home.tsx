import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import RegularUTXOs from '../components/RegularUTXOs';
import CashTokenUTXOs from '../components/CashTokenUTXOs';
import BitcoinCashCard from '../components/BitcoinCashCard';
import CashTokenCard from '../components/CashTokenCard';
import KeyService from '../services/KeyService';
import UTXOService from '../services/UTXOService';
import { setUTXOs } from '../redux/utxoSlice';

const batchAmount = 10;

const Home: React.FC = () => {
  const [keyPairs, setKeyPairs] = useState([]);
  const [utxoProgress, setUtxoProgress] = useState(0);
  const [generatingKeys, setGeneratingKeys] = useState(false);
  const [fetchingUTXOs, setFetchingUTXOs] = useState(false);
  const [showPopup, setShowPopup] = useState(false);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const reduxUTXOs = useSelector((state: RootState) => state.utxos.utxos);

  const initialized = useRef(false);

  const generateKeys = useCallback(async () => {
    if (!currentWalletId || generatingKeys) return;

    setGeneratingKeys(true);
    const existingKeys = await KeyService.retrieveKeys(currentWalletId);
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
    setGeneratingKeys(false);
  }, [currentWalletId, generatingKeys]);

  const fetchAndStoreUTXOs = useCallback(async () => {
    if (fetchingUTXOs || !currentWalletId) return;

    setFetchingUTXOs(true);
    const allUTXOs: Record<string, any[]> = {};
    const totalKeyPairs = keyPairs.length;

    try {
      let completed = 0;

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
          completed++;
          setUtxoProgress((completed / totalKeyPairs) * 100);
        }
      }

      dispatch(setUTXOs({ newUTXOs: allUTXOs }));
    } catch (error) {
      console.error('Error fetching UTXOs:', error);
    } finally {
      setFetchingUTXOs(false);
    }
  }, [keyPairs, fetchingUTXOs, currentWalletId, dispatch]);

  useEffect(() => {
    if (initialized.current || !currentWalletId) return;

    const initializeUTXOs = async () => {
      await generateKeys();
      if (Object.keys(reduxUTXOs).length === 0) {
        await fetchAndStoreUTXOs();
      }
    };

    initializeUTXOs();
    initialized.current = true;
  }, [currentWalletId, generateKeys, reduxUTXOs, fetchAndStoreUTXOs]);

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

  const filterRegularUTXOs = (utxos: any[]) =>
    utxos.filter((utxo) => !utxo.token_data);

  const filterCashTokenUTXOs = (utxos: any[]) =>
    utxos.filter((utxo) => utxo.token_data);

  const calculateTotalBitcoinCash = () =>
    Object.values(reduxUTXOs)
      .flat()
      .filter((utxo) => !utxo.token_data)
      .reduce((acc, utxo) => acc + utxo.amount, 0);

  const calculateCashTokenTotals = () => {
    const tokenTotals: Record<string, number> = {};
    Object.values(reduxUTXOs)
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
    <div className="container mx-auto p-4 pb-16">
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
          className="mt-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md"
          onClick={fetchAndStoreUTXOs}
          disabled={fetchingUTXOs || generatingKeys}
        >
          Fetch UTXOs
        </button>
        <button
          className="mt-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md"
          onClick={() => handleGenerateKeys(keyPairs.length)}
          disabled={fetchingUTXOs || generatingKeys}
        >
          Generate New Key
        </button>
      </div>
      <button
        className="w-full max-w-md mx-auto mt-4 flex items-center justify-center"
        onClick={togglePopup}
      >
        <BitcoinCashCard totalAmount={calculateTotalBitcoinCash()} />
      </button>
      {fetchingUTXOs && (
        <div className="w-full max-w-md mx-auto mt-4">
          <div className="relative pt-1">
            <div className="flex mb-2 items-center justify-between">
              <div>
                <span className="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full text-green-600 bg-green-200">
                  Fetching UTXOs...
                </span>
              </div>
              <div className="text-right">
                <span className="text-xs font-semibold inline-block text-green-600">
                  {Math.round(utxoProgress)}%
                </span>
              </div>
            </div>
            <div className="overflow-hidden h-2 mb-4 text-xs flex rounded bg-green-200">
              <div
                style={{ width: `${utxoProgress}%` }}
                className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-green-500"
              ></div>
            </div>
          </div>
        </div>
      )}
      <div
        className="w-full max-w-md mx-auto mt-4 overflow-y-auto"
        style={{ maxHeight: '50vh' }}
      >
        {Object.entries(calculateCashTokenTotals()).map(
          ([category, amount]) => (
            <CashTokenCard
              key={category}
              category={category}
              totalAmount={amount}
            />
          )
        )}
      </div>
      {showPopup && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50">
          <div className="relative top-20 mx-auto p-5 w-3/4 bg-white rounded-md shadow-lg">
            <div className="text-center text-lg font-bold">
              All Address Information
            </div>
            <div className="max-h-96 overflow-y-auto">
              {keyPairs.map((keyPair, index) => (
                <div
                  key={index}
                  className="p-4 mb-4 bg-white rounded-lg shadow-md"
                >
                  <p>
                    <strong>Address:</strong> {keyPair.address}
                  </p>
                  <RegularUTXOs
                    utxos={filterRegularUTXOs(
                      reduxUTXOs[keyPair.address] || []
                    )}
                    loading={loading[keyPair.address]}
                  />
                  <CashTokenUTXOs
                    utxos={filterCashTokenUTXOs(
                      reduxUTXOs[keyPair.address] || []
                    )}
                    loading={loading[keyPair.address]}
                  />
                </div>
              ))}
            </div>
            <button
              className="mt-4 w-full bg-red-500 text-white rounded hover:bg-red-600"
              onClick={togglePopup}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Home;
