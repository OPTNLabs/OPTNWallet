// src/components/WcConnectionManager.tsx

import React, { useState } from 'react';
import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../state/store';
import {
  initWalletConnect,
  wcPair,
} from '../state/slices/walletconnectSlice';
import { enqueueNotification } from '../state/slices/notificationsSlice';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../utils/barcodeScanner';
import ConnectionUriScanCard from './connect/ConnectionUriScanCard';

const WcConnectionManager: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const [scanning, setScanning] = useState<boolean>(false);
  const [uri, setUri] = useState('');

  const handleManualConnect = async () => {
    // console.log('[WcConnectionManager] handleManualConnect called with:', uri);
    if (!uri.trim().startsWith('wc:')) {
      console.warn('[WcConnectionManager] Invalid WC URI:', uri);
      dispatch(
        enqueueNotification({
          id: `walletconnect:manual:invalid:${Date.now()}`,
          kind: 'walletconnect',
          title: 'WalletConnect',
          body: 'Please provide a valid WalletConnect URI.',
          createdAt: Date.now(),
        })
      );
      return;
    }
    try {
      await dispatch(initWalletConnect()).unwrap();
      // console.log('[WcConnectionManager] Dispatching wcPair');
      await dispatch(wcPair(uri.trim())).unwrap();
      // console.log('[WcConnectionManager] Manual connect successful');
      dispatch(
        enqueueNotification({
          id: `walletconnect:manual:success:${Date.now()}`,
          kind: 'walletconnect',
          title: 'WalletConnect paired',
          body: 'The WalletConnect session is now waiting for the dApp request.',
          createdAt: Date.now(),
        })
      );
    } catch (err) {
      console.error('[WcConnectionManager] Error pairing manually:', err);
      dispatch(
        enqueueNotification({
          id: `walletconnect:manual:error:${Date.now()}`,
          kind: 'walletconnect',
          title: 'WalletConnect pairing failed',
          body: String(err),
          createdAt: Date.now(),
        })
      );
    }
  };

  const handleScan = async () => {
    // console.log('[WcConnectionManager] handleScan called');
    try {
      setScanning(true);
      await dispatch(initWalletConnect()).unwrap();
      const result = await scanBarcodeSafely({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });
      // console.log('[WcConnectionManager] Scan result:', result);
      if (result && result.ScanResult) {
        const scannedData = result.ScanResult.trim();
        if (scannedData.startsWith('wc:')) {
          // console.log(
          //   '[WcConnectionManager] dispatching wcPair for scannedData'
          // );
          await dispatch(wcPair(scannedData)).unwrap();
          // console.log('[WcConnectionManager] QR connect successful');
          dispatch(
            enqueueNotification({
              id: `walletconnect:qr:success:${Date.now()}`,
              kind: 'walletconnect',
              title: 'WalletConnect paired',
              body: 'WalletConnect pairing successful via QR.',
              createdAt: Date.now(),
            })
          );
        } else {
          console.warn(
            '[WcConnectionManager] Not a valid wc: URI:',
            scannedData
          );
          dispatch(
            enqueueNotification({
              id: `walletconnect:qr:invalid:${Date.now()}`,
              kind: 'walletconnect',
              title: 'WalletConnect',
              body: 'Not a valid WalletConnect URI.',
              createdAt: Date.now(),
            })
          );
        }
      } else {
        dispatch(
          enqueueNotification({
            id: `walletconnect:qr:none:${Date.now()}`,
            kind: 'walletconnect',
            title: 'WalletConnect',
            body: 'No QR code detected. Try again.',
            createdAt: Date.now(),
          })
        );
      }
    } catch (err) {
      console.error('[WcConnectionManager] Scan error:', err);
      dispatch(
        enqueueNotification({
          id: `walletconnect:qr:error:${Date.now()}`,
          kind: 'walletconnect',
          title: 'WalletConnect scan failed',
          body: getBarcodeScannerErrorMessage(err),
          createdAt: Date.now(),
        })
      );
    } finally {
      setScanning(false);
      // console.log('[WcConnectionManager] Scan finished');
    }
  };

  return (
    <ConnectionUriScanCard
      label="Enter WalletConnect URI:"
      placeholder="wc:..."
      value={uri}
      onChange={setUri}
      onScan={handleScan}
      onConnect={handleManualConnect}
      scanning={scanning}
      submitting={false}
      connectLabel="Connect"
    />
  );
};

export default WcConnectionManager;
