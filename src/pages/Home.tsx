// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import KeyManager from '../apis/WalletManager/KeyManager';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import UTXOManager from '../apis/UTXOManager/UTXOManager';
import WalletManager from '../apis/WalletManager/WalletManager';
import RegularUTXOs from '../components/RegularUTXOs';
import CashTokenUTXOs from '../components/CashTokenUTXOs';
import ElectrumService from '../apis/ElectrumServer/ElectrumServer';
import { setUTXOs } from '../redux/utxoSlice';
import BitcoinCashCard from '../components/BitcoinCashCard';
import CashTokenCard from '../components/CashTokenCard';

const batchAmount = 10;

const Home = () => {
  const [keyPairs, setKeyPairs] = useState([]);
  const [utxos, setUtxos] = useState({});
  const [loading, setLoading] = useState({});
  const [cashTokenUtxos, setCashTokenUtxos] = useState({});
  const [keyProgress, setKeyProgress] = useState(0);
  const [utxoProgress, setUtxoProgress] = useState(0);
  const [generatingKeys, setGeneratingKeys] = useState(false);
  const [fetchingUTXOs, setFetchingUTXOs] = useState(false);
  const [showPopup, setShowPopup] = useState(false);
  const KeyManage = KeyManager();
  const dbService = DatabaseService();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { wallet_id } = useParams<{ wallet_id: string }>();
  const WalletManage = WalletManager();
  const ManageUTXOsRef = useRef(null);

  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const totalBalance = useSelector(
    (state: RootState) => state.utxos.totalBalance
  );
  const reduxUTXOs = useSelector((state: RootState) => state.utxos.utxos);

  useEffect(() => {
    const initializeUTXOManager = async () => {
      ManageUTXOsRef.current = await UTXOManager();
      if (currentWalletId) {
        await generateKeys();
        if (Object.keys(reduxUTXOs).length > 0) {
          setUtxosFromRedux(reduxUTXOs);
        } else {
          await fetchUTXOsFromDatabase(currentWalletId);
        }
      }
    };

    initializeUTXOManager();
  }, [currentWalletId, reduxUTXOs]);

  const setUtxosFromRedux = (reduxUTXOs) => {
    const utxosMap = {};
    const cashTokenUtxosMap = {};

    Object.keys(reduxUTXOs).forEach((address) => {
      const addressUTXOs = reduxUTXOs[address];
      utxosMap[address] = addressUTXOs.filter((utxo) => !utxo.token_data);
      cashTokenUtxosMap[address] = addressUTXOs.filter(
        (utxo) => utxo.token_data
      );
    });

    setUtxos(utxosMap);
    setCashTokenUtxos(cashTokenUtxosMap);
  };

  const generateKeys = async () => {
    if (currentWalletId) {
      setGeneratingKeys(true);
      const existingKeys = await KeyManage.retrieveKeys(currentWalletId);
      setKeyPairs(existingKeys);

      let newKeys = [];
      const keySet = new Set(existingKeys.map((key) => key.address));
      if (existingKeys.length < batchAmount) {
        for (let i = existingKeys.length; i < batchAmount; i++) {
          const newKey = await handleGenerateKeys(i);
          if (newKey && !keySet.has(newKey.address)) {
            newKeys.push(newKey);
            keySet.add(newKey.address);
          }
          setKeyProgress(((i + 1) / batchAmount) * 100);
        }
        setKeyPairs([...existingKeys, ...newKeys]);
      }
      setGeneratingKeys(false);
    }
  };

  const fetchUTXOs = async (walletKeys) => {
    setFetchingUTXOs(true);
    const utxosMap = {};
    const cashTokenUtxosMap = {};
    const uniqueUTXOs = new Set();
    const loadingState = {};
    let total = 0;

    const electrumService = ElectrumService();
    await electrumService.electrumConnect();

    for (const key of walletKeys) {
      loadingState[key.address] = true;
    }
    setLoading(loadingState);

    for (let i = 0; i < walletKeys.length; i++) {
      const key = walletKeys[i];
      console.log(`Key ${i}:`, key.address);
      const addressUTXOs = await ManageUTXOsRef.current.fetchUTXOsByAddress(
        currentWalletId,
        key.address
      );
      console.log(`Fetched UTXOs for address ${key.address}:`, addressUTXOs);

      utxosMap[key.address] = addressUTXOs.filter((utxo) => {
        const utxoKey = `${utxo.tx_hash}-${utxo.tx_pos}-${utxo.address}`;
        if (uniqueUTXOs.has(utxoKey)) {
          return false;
        }
        if (utxo.address === key.address && !utxo.token_data) {
          uniqueUTXOs.add(utxoKey);
          total += utxo.amount;
          return true;
        }
        return false;
      });

      cashTokenUtxosMap[key.address] = addressUTXOs.filter((utxo) => {
        const utxoKey = `${utxo.tx_hash}-${utxo.tx_pos}-${utxo.address}`;
        if (uniqueUTXOs.has(utxoKey)) {
          return false;
        }
        if (utxo.address === key.address && utxo.token_data) {
          uniqueUTXOs.add(utxoKey);
          total += utxo.amount;
          return true;
        }
        return false;
      });

      loadingState[key.address] = false;
      setLoading({ ...loadingState });
      setUtxoProgress(((i + 1) / walletKeys.length) * 100);
    }

    await electrumService.electrumDisconnect();

    setUtxos(utxosMap);
    setCashTokenUtxos(cashTokenUtxosMap);
    setFetchingUTXOs(false);

    // Update Redux with the new UTXOs
    const newUTXOs = walletKeys.reduce((acc, key) => {
      acc[key.address] = [
        ...utxosMap[key.address],
        ...cashTokenUtxosMap[key.address],
      ];
      return acc;
    }, {});
    dispatch(setUTXOs({ newUTXOs }));
  };

  const fetchUTXOsFromDatabase = async (walletId) => {
    const utxosMap = {};
    const cashTokenUtxosMap = {};

    for (const key of keyPairs) {
      const addressUTXOs = await ManageUTXOsRef.current.fetchUTXOsByAddress(
        walletId,
        key.address
      );
      console.log(`Stored UTXOs for address ${key.address}:`, addressUTXOs);

      utxosMap[key.address] = addressUTXOs.filter((utxo) => !utxo.token_data);
      cashTokenUtxosMap[key.address] = addressUTXOs.filter(
        (utxo) => utxo.token_data
      );
    }

    setUtxos(utxosMap);
    setCashTokenUtxos(cashTokenUtxosMap);

    // Update Redux with the stored UTXOs
    const newUTXOs = keyPairs.reduce((acc, key) => {
      acc[key.address] = [
        ...utxosMap[key.address],
        ...cashTokenUtxosMap[key.address],
      ];
      return acc;
    }, {});
    dispatch(setUTXOs({ newUTXOs }));
  };

  const handleGenerateKeys = async (index) => {
    if (currentWalletId != null) {
      await KeyManage.createKeys(
        currentWalletId,
        0, // accountNumber
        0, // changeNumber
        index // addressNumber based on the current index
      );
      await dbService.saveDatabaseToFile();
      const newKeys = await KeyManage.retrieveKeys(currentWalletId);
      return newKeys[newKeys.length - 1];
    }
  };

  const togglePopup = () => {
    setShowPopup(!showPopup);
  };

  const handleFetchUTXOsClick = () => {
    fetchUTXOs(keyPairs);
  };

  const handleGenerateNewKey = async () => {
    const newKey = await handleGenerateKeys(keyPairs.length);
    const keySet = new Set(keyPairs.map((key) => key.address));
    if (newKey && !keySet.has(newKey.address)) {
      setKeyPairs((prevKeys) => [...prevKeys, newKey]);
      fetchUTXOs([newKey]);
    }
  };

  const toContractView = async () => {
    navigate(`/contract`);
  };

  const calculateTotalBitcoinCash = () => {
    return Object.values(utxos)
      .flat()
      .reduce((acc, utxo) => acc + utxo.amount, 0);
  };

  const calculateCashTokenTotals = () => {
    const tokenTotals = {};
    Object.values(cashTokenUtxos)
      .flat()
      .forEach((utxo) => {
        let tokenData = utxo.token_data;

        if (typeof tokenData === 'string') {
          try {
            tokenData = JSON.parse(tokenData);
          } catch (error) {
            console.error('Error parsing token_data:', error);
            tokenData = {};
          }
        }

        const category = tokenData.category;
        const amount = parseFloat(tokenData.amount);

        if (category) {
          if (tokenTotals[category]) {
            tokenTotals[category] += amount;
          } else {
            tokenTotals[category] = amount;
          }
        }
      });

    console.log('Token Totals:', tokenTotals); // Debug statement
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
          onClick={toContractView}
        >
          Contracts
        </button>
        <button
          className="mt-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md"
          onClick={handleFetchUTXOsClick}
          disabled={fetchingUTXOs || generatingKeys}
        >
          Fetch UTXOs
        </button>
        <button
          className="mt-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md"
          onClick={handleGenerateNewKey}
          disabled={fetchingUTXOs || generatingKeys}
        >
          Generate New Key
        </button>
      </div>
      {/* <div className="font-bold text-xl text-center mt-4">
        Regular Balance: {totalBalance} satoshis
      </div> */}
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
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-20">
          <div className="relative top-20 mx-auto p-5 border w-3/4 shadow-lg rounded-md bg-white">
            <div className="text-center text-lg font-bold mb-4">
              All Address Information
            </div>
            <div className="overflow-y-auto max-h-96">
              {keyPairs.length > 0 ? (
                keyPairs.map((keyPair, index) => (
                  <div
                    key={index}
                    className="p-4 mb-4 border rounded-lg shadow-md bg-white overflow-x-auto"
                  >
                    <p className="text-sm break-words">
                      <strong>Address:</strong> {keyPair.address}
                    </p>
                    <p className="text-sm break-words">
                      <strong>CashToken Address:</strong> {keyPair.tokenAddress}
                    </p>
                    <RegularUTXOs
                      address={keyPair.address}
                      utxos={utxos[keyPair.address]}
                      loading={loading[keyPair.address]}
                    />
                    <CashTokenUTXOs
                      address={keyPair.address}
                      utxos={cashTokenUtxos[keyPair.address]}
                      loading={loading[keyPair.address]}
                    />
                  </div>
                ))
              ) : (
                <p className="text-center">No keys available yet.</p>
              )}
            </div>
            <button
              className="mt-4 p-2 bg-red-500 text-white rounded hover:bg-red-600 transition duration-300 w-full"
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
