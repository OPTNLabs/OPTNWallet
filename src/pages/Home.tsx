// src/pages/Home.tsx
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
import { setUTXOs, clearUTXOs } from '../redux/utxoSlice';

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
  }, [currentWalletId]);

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
    walletKeys.forEach((key) => {
      dispatch(
        setUTXOs({
          address: key.address,
          utxos: [...utxosMap[key.address], ...cashTokenUtxosMap[key.address]],
        })
      );
    });
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
    keyPairs.forEach((key) => {
      dispatch(
        setUTXOs({
          address: key.address,
          utxos: [...utxosMap[key.address], ...cashTokenUtxosMap[key.address]],
        })
      );
    });
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

  return (
    <>
      <section className="flex flex-col min-h-screen bg-gray-100 p-4">
        <div className="text-xl font-bold text-center mb-4">
          Hello {currentWalletId}
        </div>
        <div className="text-lg font-semibold text-center mt-4 mb-2">
          Generating Public/Private Keys:
        </div>
        {generatingKeys && (
          <div className="w-full max-w-md mx-auto">
            <div className="relative pt-1">
              <div className="flex mb-2 items-center justify-between">
                <div>
                  <span className="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full text-blue-600 bg-blue-200">
                    Generating Keys...
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-xs font-semibold inline-block text-blue-600">
                    {Math.round(keyProgress)}%
                  </span>
                </div>
              </div>
              <div className="overflow-hidden h-2 mb-4 text-xs flex rounded bg-blue-200">
                <div
                  style={{ width: `${keyProgress}%` }}
                  className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-blue-500"
                ></div>
              </div>
            </div>
          </div>
        )}
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
        <button
          className="mt-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md mx-auto"
          onClick={togglePopup}
        >
          Show All Addresses
        </button>
        <button
          className="mt-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md mx-auto"
          onClick={handleFetchUTXOsClick}
          disabled={fetchingUTXOs || generatingKeys}
        >
          Fetch UTXOs
        </button>
        <button
          className="mt-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md mx-auto"
          onClick={handleGenerateNewKey}
          disabled={fetchingUTXOs || generatingKeys}
        >
          Generate New Key
        </button>
        {showPopup && (
          <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full">
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
                        <strong>CashToken Address:</strong>{' '}
                        {keyPair.tokenAddress}
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
        <div className="font-bold text-xl text-center mt-4">
          Total Balance: {totalBalance}
        </div>
      </section>
    </>
  );
};

export default Home;
