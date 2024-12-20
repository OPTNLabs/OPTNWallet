// src/components/SweepPaperWallet.tsx

import React, { useState } from 'react';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import {
  decodePrivateKeyWif,
  privateKeyToP2pkhCashAddress,
} from '@bitauth/libauth-v3';
// import RegularUTXOs from './RegularUTXOs';
import { FaCamera } from 'react-icons/fa';
import ElectrumService from '../services/ElectrumService';
import { UTXO } from '../types/types';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { PREFIX } from '../utils/constants';

interface SweepPaperWalletProps {
  setPaperWalletUTXOs: React.Dispatch<React.SetStateAction<UTXO[]>>;
}

const SweepPaperWallet: React.FC<SweepPaperWalletProps> = ({
  setPaperWalletUTXOs,
}) => {
  // State variables
  // const [wifKey, setWifKey] = useState<string>('');
  const [cashAddress, setCashAddress] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );

  // Handler to initiate QR code scanning
  const handleScan = async () => {
    try {
      // Optionally, check and request permissions here
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.ALL, // Hint for WIF format
        cameraDirection: 1, // 0 for front, 1 for back
      });

      if (result && result.ScanResult) {
        const scannedWif = result.ScanResult.trim();
        // setWifKey(scannedWif);
        await processWifKey(scannedWif);
      } else {
        await Toast.show({
          text: 'No QR code detected. Please try again.',
        });
      }
    } catch (err) {
      console.error('Scan error:', err);
      await Toast.show({
        text: 'Failed to scan QR code. Please ensure camera permissions are granted and try again.',
      });
    }
  };

  // Function to process the WIF key
  const processWifKey = async (wif: string) => {
    setLoading(true);
    setError('');
    setCashAddress('');

    try {
      // Decode the WIF key
      const decoded = decodePrivateKeyWif(wif);

      if (typeof decoded === 'string') {
        // It's an error message
        setError(decoded);
        await Toast.show({
          text: `Decoding Error: ${decoded}`,
        });
        setLoading(false);
        return;
      }

      const { privateKey: pkArray } = decoded;

      // Convert private key to Cash Address
      const addressResult = privateKeyToP2pkhCashAddress({
        privateKey: pkArray,
        prefix: PREFIX[currentNetwork], // Adjust as needed: 'bitcoincash', 'bchtest', 'bchreg'
        throwErrors: true,
        tokenSupport: false,
      });

      if (typeof addressResult === 'string') {
        // It's an error message
        setError(addressResult);
        await Toast.show({
          text: `Address Conversion Error: ${addressResult}`,
        });
        setLoading(false);
        return;
      }

      const { address } = addressResult;

      setCashAddress(address);

      // Fetch UTXOs
      const fetchedUtxos = await ElectrumService.getUTXOS(address).then(
        (res) => {
          return res.filter((utxo) => !utxo.token_data);
        }
      );

      if (fetchedUtxos.length === 0) {
        await Toast.show({
          text: 'No UTXOs found for this address.',
        });
      } else {
        // Mark UTXOs as paper wallet UTXOs
        const markedUtxos = fetchedUtxos.map((utxo) => ({
          ...utxo,
          id: undefined,
          isPaperWallet: true,
          address: address,
          amount: utxo.value,
        }));
        await Toast.show({
          text: `Fetched ${markedUtxos.length} UTXO(s).`,
        });
        setPaperWalletUTXOs(markedUtxos);
      }
    } catch (err) {
      console.error('Processing Error:', err);
      setError('An unexpected error occurred.');
      await Toast.show({
        text: 'An unexpected error occurred. Please try again.',
      });
    } finally {
      setLoading(false);
    }
  };

  // // Handler to manually input WIF key (optional)
  // const handleManualInput = async () => {
  //   if (!wifKey) {
  //     await Toast.show({
  //       text: 'Please enter a WIF key.',
  //     });
  //     return;
  //   }

  //   await processWifKey(wifKey);
  // };

  return (
    <div className="flex items-center">
      {/* <h3 className="text-lg font-semibold mb-2">Sweep Paper Wallet</h3> */}
      {/* QR Code Scanning Section */}
      {/* <div className="mb-2"> */}
      <button
        onClick={handleScan}
        className="bg-green-500 font-bold text-white py-2 px-4 rounded flex items-center flex-1"
        disabled={loading}
      >
        <FaCamera className="mr-2" /> Scan
      </button>
      {/* </div> */}
      {/* OR Divider */}
      {/* <div className="flex items-center mb-4">
        <hr className="flex-grow border-gray-300" />
        <span className="mx-2 text-gray-500">OR</span>
        <hr className="flex-grow border-gray-300" />
      </div> */}
      {/* Manual WIF Input Section */}
      {/* <div className="mb-4">
        <label
          htmlFor="wifInput"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Enter WIF Private Key
        </label>
        <input
          type="text"
          id="wifInput"
          value={wifKey}
          onChange={(e) => setWifKey(e.target.value)}
          className="border p-2 w-full rounded-md"
          placeholder="L1aW4aubDFB7yfras2S1mN3bqg9w1e..."
        />
        <button
          onClick={handleManualInput}
          className="mt-2 bg-blue-500 text-white py-2 px-4 rounded"
          disabled={loading}
        >
          Submit WIF
        </button>
      </div> */}
      {/* Loading Indicator */}
      {/* {loading && (
        <div className="mb-4">
          <span className="text-blue-500">Processing...</span>
        </div>
      )} */}
      {/* Error Message */}
      {error && (
        <div className="mb-4 text-red-500">
          <span>{error}</span>
        </div>
      )}
      {/* Cash Address Display */}
      {cashAddress && (
        <div className="mb-4">
          <h4 className="text-md font-semibold mb-2">Cash Address</h4>
          <p className="bg-gray-100 p-2 rounded break-words">{cashAddress}</p>
        </div>
      )}
    </div>
  );
};

export default SweepPaperWallet;
