// @ts-nocheck
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
  const [retrieve, setRetrieve] = useState(false);
  const [utxos, setUtxos] = useState<{ [address: string]: any[] }>({});
  const [loading, setLoading] = useState<{ [address: string]: boolean }>({});
  const [addressIndex, setAddressIndex] = useState(0);
  const [totalBalance, setTotalBalance] = useState(0);
  const [cashTokenUtxos, setCashTokenUtxos] = useState<{
    [address: string]: any[];
  }>({});
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
      tokenAddress: string;
    }[]
  ) => {
    const utxosMap: { [address: string]: any[] } = {};
    const cashTokenUtxosMap: { [address: string]: any[] } = {};
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
    }
    setUtxos(utxosMap);
    setCashTokenUtxos(cashTokenUtxosMap);
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

  const viewContracts = async () => {
    navigate(`/contract/`);
  };

  return (
    <>
      <section className="flex flex-col min-h-screen bg-gray-100 p-4">
        <div className="text-xl font-bold text-center mb-4">
          Hello {wallet_id}
        </div>
        <button
          className="mt-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md mx-auto"
          onClick={viewContracts}
        >
          View Contracts
        </button>
        <div className="text-lg font-semibold text-center mt-4 mb-2">
          Generate Public/Private Key here:
        </div>
        <button
          className="mb-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md mx-auto"
          onClick={handleGenerateKeys}
        >
          Generate
        </button>
        <div className="w-full max-w-md mx-auto">
          {keyPairs.map((keyPair, index) => (
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
          ))}
        </div>
        <div className="font-bold text-xl text-center mt-4">
          Total Balance: {totalBalance}
        </div>
        <button
          className="mt-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md mx-auto"
          onClick={storeUTXOs}
        >
          Check UTXOs
        </button>
        <button
          className="mt-4 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300 w-full max-w-md mx-auto"
          onClick={buildTransaction}
        >
          Build Transaction
        </button>
        <button
          className="mt-4 p-2 bg-red-500 text-white rounded hover:bg-red-600 transition duration-300 w-full max-w-md mx-auto"
          onClick={deleteWallet}
        >
          Log Out
        </button>
      </section>
    </>
  );
};

export default Home;
