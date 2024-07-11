import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import KeyManager from '../apis/WalletManager/KeyManager';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import UTXOManager from '../apis/UTXOManager/UTXOManager';
import WalletManager from '../apis/WalletManager/WalletManager';

const Home = () => {
  const [keyPairs, setKeyPairs] = useState<
    {
      id: number;
      publicKey: Uint8Array;
      privateKey: Uint8Array;
      address: string;
    }[]
  >([]);
  const [retrieve, setRetrieve] = useState(false);
  const [utxos, setUtxos] = useState<{ [address: string]: any[] }>({});
  const [loading, setLoading] = useState<{ [address: string]: boolean }>({});
  const [addressIndex, setAddressIndex] = useState(0);
  const [totalBalance, setTotalBalance] = useState(0);
  const KeyManage = KeyManager();
  const dbService = DatabaseService();
  const navigate = useNavigate();
  const { wallet_id } = useParams<{ wallet_id: string }>();
  const ManageUTXOs = UTXOManager();
  const WalletManage = WalletManager();

  useEffect(() => {
    const retrieveWalletInformation = async () => {
      if (wallet_id) {
        const wallet_id_number = parseInt(wallet_id, 10);
        const walletKeys = await KeyManage.retrieveKeys(wallet_id_number);
        setKeyPairs(walletKeys);
        setAddressIndex(walletKeys.length); // Set address index based on the number of keys
        await fetchUTXOs(walletKeys);
      }
    };
    retrieveWalletInformation();
  }, [retrieve]);

  const fetchData = () => {
    setRetrieve((prev) => !prev);
  };

  const storeUTXOs = async () => {
    if (wallet_id) {
      const wallet_id_number = parseInt(wallet_id, 10);
      await (await ManageUTXOs).checkNewUTXOs(wallet_id_number);
      fetchData(); // Fetch data again after storing UTXOs to refresh the view
    }
  };

  const fetchUTXOs = async (
    walletKeys: {
      id: number;
      publicKey: Uint8Array;
      privateKey: Uint8Array;
      address: string;
    }[]
  ) => {
    const utxosMap: { [address: string]: any[] } = {};
    const uniqueUTXOs = new Set(); // To ensure uniqueness of UTXOs
    const loadingState: { [address: string]: boolean } = {};
    let total = 0;

    for (const key of walletKeys) {
      loadingState[key.address] = true;
    }
    setLoading(loadingState);

    for (const key of walletKeys) {
      const addressUTXOs = await (
        await ManageUTXOs
      ).fetchUTXOs(parseInt(wallet_id!, 10));
      utxosMap[key.address] = addressUTXOs.filter((utxo) => {
        const utxoKey = `${utxo.tx_hash}-${utxo.tx_pos}-${utxo.address}`;
        if (uniqueUTXOs.has(utxoKey)) {
          return false;
        }
        if (utxo.address === key.address) {
          uniqueUTXOs.add(utxoKey);
          total += utxo.amount;
          return true;
        }
        return false;
      });
      loadingState[key.address] = false;
      setLoading({ ...loadingState });
    }
    setUtxos(utxosMap);
    setTotalBalance(total);
  };

  const handleGenerateKeys = async () => {
    if (wallet_id != null) {
      const wallet_id_number = parseInt(wallet_id, 10);
      await KeyManage.createKeys(
        wallet_id_number,
        0, // accountNumber
        0, // changeNumber
        addressIndex // addressNumber based on the number of existing keys
      );
      await dbService.saveDatabaseToFile();
      fetchData();
    }
  };

  const deleteWallet = async () => {
    if (!wallet_id) {
      return;
    }
    const wallet_id_number = parseInt(wallet_id, 10);
    const checkDelete = await WalletManage.deleteWallet(wallet_id_number);
    if (checkDelete) {
      navigate(`/`);
    }
  };

  const buildTransaction = async () => {
    navigate(`/transaction/`);
  };

  return (
    <>
      <section className="flex flex-col min-h-screen">
        <div>Hello {wallet_id} </div>
        <div>Generate Public/Private Key here:</div>
        <button
          className="mb-4 p-2 bg-blue-500 text-white rounded"
          onClick={handleGenerateKeys}
        >
          Generate
        </button>
        <div>
          {keyPairs.map((keyPair, index) => (
            <div key={index} className="p-4 mb-4 border rounded-lg shadow-md">
              {/* <p>
                <strong>Public Key:</strong>{' '}
                {uint8ArrayToHexString(keyPair.publicKey)}
              </p>
              <p>
                <strong>Private Key:</strong>{' '}
                {uint8ArrayToHexString(keyPair.privateKey)}
              </p> */}
              <p>
                <strong>Address:</strong> {keyPair.address}
              </p>
              <div>
                <h4 className="font-semibold">UTXOs:</h4>
                {loading[keyPair.address] ? (
                  <div className="flex items-center">
                    <svg
                      className="animate-spin h-5 w-5 mr-3 text-gray-500"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8v8H4z"
                      ></path>
                    </svg>
                    <span>Loading UTXOs...</span>
                  </div>
                ) : (
                  utxos[keyPair.address] &&
                  utxos[keyPair.address].map((utxo, idx) => (
                    <div key={idx} className="p-2 mb-2 border rounded-lg">
                      <p>
                        <strong>Amount:</strong> {utxo.amount}
                      </p>
                      <p>
                        <strong>Transaction Hash:</strong> {utxo.tx_hash}
                      </p>
                      <p>
                        <strong>Position:</strong> {utxo.tx_pos}
                      </p>
                      <p>
                        <strong>Height:</strong> {utxo.height}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="font-bold text-xl">Total Balance: {totalBalance}</div>
        <button
          className="mt-4 p-2 bg-blue-500 text-white rounded"
          onClick={storeUTXOs}
        >
          Check UTXOs
        </button>
        <button
          className="mt-4 p-2 bg-blue-500 text-white rounded"
          onClick={buildTransaction}
        >
          Build Transaction
        </button>
        <button
          className="mt-4 p-2 bg-red-500 text-white rounded"
          onClick={deleteWallet}
        >
          Log Out
        </button>
      </section>
    </>
  );
};

export default Home;
