// @ts-nocheck
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { setWalletId } from '../redux/walletSlice';
import KeyManager from '../apis/WalletManager/KeyManager';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import UTXOManager from '../apis/UTXOManager/UTXOManager';
import WalletManager from '../apis/WalletManager/WalletManager';
import RegularUTXOs from '../components/RegularUTXOs';
import CashTokenUTXOs from '../components/CashTokenUTXOs';

const Home = () => {
  const [keyPairs, setKeyPairs] = useState<
    {
      id: number;
      publicKey: Uint8Array;
      privateKey: Uint8Array;
      address: string;
      tokenAddress: string;
    }[]
  >([]);
  const [utxos, setUtxos] = useState<{ [address: string]: any[] }>({});
  const [loading, setLoading] = useState<{ [address: string]: boolean }>({});
  const [totalBalance, setTotalBalance] = useState(0);
  const [cashTokenUtxos, setCashTokenUtxos] = useState<{
    [address: string]: any[];
  }>({});
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

  useEffect(() => {
    const initializeUTXOManager = async () => {
      ManageUTXOsRef.current = await UTXOManager();
      generateKeysAndFetchUTXOs();
    };

    const generateKeysAndFetchUTXOs = async () => {
      if (wallet_id && keyPairs.length === 0) {
        setGeneratingKeys(true);
        const newKeys = [];
        for (let i = 0; i < 20; i++) {
          const newKey = await handleGenerateKeys(i);
          newKeys.push(newKey);
          setKeyProgress(((i + 1) / 20) * 100);
        }
        setKeyPairs(newKeys);
        setGeneratingKeys(false);
        fetchUTXOs(newKeys); // Automatically fetch UTXOs after generating keys
      }
    };

    initializeUTXOManager();
  }, [wallet_id]);

  const fetchUTXOs = async (
    walletKeys: {
      id: number;
      publicKey: Uint8Array;
      privateKey: Uint8Array;
      address: string;
      tokenAddress: string;
    }[]
  ) => {
    setFetchingUTXOs(true);
    const utxosMap: { [address: string]: any[] } = {};
    const cashTokenUtxosMap: { [address: string]: any[] } = {};
    const uniqueUTXOs = new Set(); // To ensure uniqueness of UTXOs
    const loadingState: { [address: string]: boolean } = {};
    let total = 0;

    for (const key of walletKeys) {
      loadingState[key.address] = true;
    }
    setLoading(loadingState);

    for (let i = 0; i < walletKeys.length; i++) {
      const key = walletKeys[i];
      const addressUTXOs = await ManageUTXOsRef.current.fetchUTXOs(
        parseInt(wallet_id!, 10)
      );
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
      setTotalBalance(total);
      setUtxoProgress(((i + 1) / walletKeys.length) * 100);
    }
    setUtxos(utxosMap);
    setCashTokenUtxos(cashTokenUtxosMap);
    setFetchingUTXOs(false);
  };

  const handleGenerateKeys = async (index) => {
    if (wallet_id != null) {
      const wallet_id_number = parseInt(wallet_id, 10);
      await KeyManage.createKeys(
        wallet_id_number,
        0, // accountNumber
        0, // changeNumber
        index // addressNumber based on the current index
      );
      await dbService.saveDatabaseToFile();
      const newKeys = await KeyManage.retrieveKeys(wallet_id_number); // Retrieve updated keys
      return newKeys[newKeys.length - 1]; // Return the last generated key
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
    setKeyPairs((prevKeys) => [...prevKeys, newKey]);
    fetchUTXOs([newKey]); // Fetch UTXOs for the new key
  };

  return (
    <>
      <section className="flex flex-col min-h-screen bg-gray-100 p-4">
        <div className="text-xl font-bold text-center mb-4">
          Hello {wallet_id}
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
