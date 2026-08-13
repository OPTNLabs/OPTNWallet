import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import type { AppDispatch, RootState } from '../../state/store';
import {
  initCashConnect,
  pairCashConnectThunk,
} from '../../state/slices/cashconnectSlice';
import {
  initWalletConnect,
  wcPair,
} from '../../state/slices/walletconnectSlice';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../../utils/barcodeScanner';
import { toErrorMessage } from '../../utils/errorHandling';
import { classifyScannedQrPayload } from '../../utils/qrScan';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';

export function useHomeConnect() {
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector(selectCurrentNetwork);
  const pendingProposal = useSelector(
    (state: RootState) =>
      state.cashconnect.pendingProposal ?? state.walletconnect.pendingProposal
  );
  const pendingAction = useSelector(
    (state: RootState) =>
      state.cashconnect.pendingAction ??
      state.walletconnect.pendingSignTx ??
      state.walletconnect.pendingSignMsg
  );

  const [popupOpen, setPopupOpen] = useState(false);
  const [uri, setUri] = useState('');
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const returnTo = `/home/${currentWalletId ?? ''}`;

  useEffect(() => {
    if (pendingProposal || pendingAction) {
      setPopupOpen(false);
    }
  }, [pendingAction, pendingProposal]);

  const applyPayload = useCallback(
    async (raw: string): Promise<boolean> => {
      const scanned = raw.trim();
      if (!scanned) {
        await Toast.show({ text: 'Paste a URI or scan a QR code.' });
        return false;
      }

      const parsed = classifyScannedQrPayload(scanned, currentNetwork);

      if (parsed.kind === 'paper-wallet') {
        setPopupOpen(false);
        navigate('/paper-wallet-sweep', {
          state: { returnTo, scannedWif: parsed.paperWalletWif },
        });
        return true;
      }

      if (parsed.kind === 'recipient') {
        setPopupOpen(false);
        navigate('/send', {
          state: {
            returnTo,
            recipient: parsed.normalizedAddress,
            amountBch: parsed.amountRaw ?? '',
          },
        });
        return true;
      }

      if (parsed.kind === 'cashconnect') {
        if (!currentWalletId || currentWalletId <= 0) {
          throw new Error('No active wallet');
        }
        setPopupOpen(false);
        await dispatch(initCashConnect(currentWalletId)).unwrap();
        await dispatch(pairCashConnectThunk(parsed.uri)).unwrap();
        await Toast.show({
          text: 'CashConnect pairing started. Approve the request on this screen.',
        });
        setUri('');
        return true;
      }

      if (parsed.kind === 'walletconnect') {
        await dispatch(initWalletConnect()).unwrap();
        await dispatch(wcPair(parsed.uri)).unwrap();
        await Toast.show({
          text: 'WalletConnect pairing started. Approve the request on this screen.',
        });
        setUri('');
        return true;
      }

      await Toast.show({
        text: 'Not a supported address, CashConnect invite, or WalletConnect URI.',
      });
      return false;
    },
    [currentNetwork, currentWalletId, dispatch, navigate, returnTo]
  );

  const connectUri = useCallback(
    async (value: string) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        await applyPayload(value);
      } catch (error) {
        await Toast.show({ text: toErrorMessage(error) });
      } finally {
        setSubmitting(false);
      }
    },
    [applyPayload, submitting]
  );

  const scanQr = useCallback(async () => {
    if (scanning || submitting) return;
    try {
      setScanning(true);
      const result = await scanBarcodeSafely({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });
      const scanned = String(result?.ScanResult ?? '').trim();
      if (!scanned) {
        await Toast.show({ text: 'No QR code detected. Try again.' });
        return;
      }
      setUri(scanned);
      await connectUri(scanned);
    } catch (error) {
      await Toast.show({ text: getBarcodeScannerErrorMessage(error) });
    } finally {
      setScanning(false);
    }
  }, [connectUri, scanning, submitting]);

  const openPopup = useCallback(() => {
    setPopupOpen(true);
  }, []);

  const closePopup = useCallback(() => {
    setPopupOpen(false);
  }, []);

  return {
    popupOpen,
    uri,
    setUri,
    scanning,
    submitting,
    openPopup,
    closePopup,
    scanQr,
    connectUri,
  };
}
