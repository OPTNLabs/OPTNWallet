// src/components/SweepPaperWallet.tsx

import React, { useState } from 'react';
import {
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import {
  decodePrivateKeyWif,
  privateKeyToP2pkhCashAddress,
} from '@bitauth/libauth';
// import UTXOCard from './UTXOCard';
import { FaCamera } from 'react-icons/fa';
import ElectrumService from '../services/ElectrumService';
import { UTXO } from '../types/types';
import { PaperWalletSecretStore } from '../services/PaperWalletSecretStore';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { PREFIX } from '../utils/constants';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../utils/barcodeScanner';

interface SweepPaperWalletProps {
  setPaperWalletUTXOs: React.Dispatch<React.SetStateAction<UTXO[]>>;
}

const BASE58_WIF_PATTERN = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

const extractWifCandidates = (value: string): string[] => {
  const trimmed = value.trim();
  const candidates = [trimmed];

  const lastColonIndex = trimmed.lastIndexOf(':');
  if (lastColonIndex !== -1) {
    const suffix = trimmed.slice(lastColonIndex + 1).trim();
    if (
      suffix.length > 0 &&
      suffix !== trimmed &&
      BASE58_WIF_PATTERN.test(suffix)
    ) {
      candidates.push(suffix);
    }
  }

  return [...new Set(candidates)];
};

const SweepPaperWallet: React.FC<SweepPaperWalletProps> = ({
  setPaperWalletUTXOs,
}) => {
  // State variables
  // const [wifKey, setWifKey] = useState<string>('');
  // const [cashAddress, setCashAddress] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );

  // Handler to initiate QR code scanning
  const handleScan = async () => {
    try {
      // Optionally, check and request permissions here
      const result = await scanBarcodeSafely({
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
        text: getBarcodeScannerErrorMessage(err),
      });
    }
  };

  // Function to process the WIF key
  const processWifKey = async (wif: string) => {
    setLoading(true);
    setError('');
    PaperWalletSecretStore.clear();
    // setCashAddress('');

    try {
      // Try the scanned payload as-is first, then fall back to
      // stripping a QR label prefix like `bch_wif:`.
      const decodedResult = extractWifCandidates(wif).reduce<ReturnType<
        typeof decodePrivateKeyWif
      > | null>((result, candidate) => {
        if (result && typeof result !== 'string') {
          return result;
        }

        const decodedCandidate = decodePrivateKeyWif(candidate);
        if (typeof decodedCandidate !== 'string') {
          return decodedCandidate;
        }

        return result ?? decodedCandidate;
      }, null);

      const decoded = decodedResult ?? decodePrivateKeyWif(wif);

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

      // setCashAddress(address);

      // Fetch UTXOs
      const fetchedUtxos = await ElectrumService.getUTXOs(address).then(
        (res) => {
          return res.filter((utxo) => !utxo.token);
        }
      );

      if (fetchedUtxos.length === 0) {
        await Toast.show({
          text: 'No UTXOs found for this address.',
        });
      } else {
        // Register key in-memory per outpoint, and mark UTXOs as paper wallet UTXOs
        const markedUtxos = fetchedUtxos.map((utxo) => {
          PaperWalletSecretStore.set(utxo.tx_hash, utxo.tx_pos, pkArray);
          return {
            ...utxo,
            id: undefined,
            isPaperWallet: true,
            address: address,
            amount: utxo.value,
            // NOTE: do NOT attach privateKey to UTXO objects
          };
        });
        // await Toast.show({
        //   text: `Fetched ${markedUtxos.length} UTXO(s).`,
        // });
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

  return (
    <div className="flex items-center">
      <button
        onClick={handleScan}
        className="wallet-btn-primary font-bold py-2 px-4 flex items-center flex-1"
        disabled={loading}
      >
        <FaCamera className="mr-2" /> Scan
      </button>
      {/* Error Message */}
      {error && (
        <div className="mb-4 wallet-danger-text">
          <span>{error}</span>
        </div>
      )}
      {/* Cash Address Display */}
      {/* {cashAddress && (
        <div className="mb-4">
          <h4 className="text-md font-semibold mb-2">Cash Address</h4>
          <p className="wallet-surface-strong p-2 rounded break-words">{cashAddress}</p>
        </div>
      )} */}
    </div>
  );
};

export default SweepPaperWallet;
