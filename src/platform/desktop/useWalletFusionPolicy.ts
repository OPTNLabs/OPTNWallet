// Bind the Fusion policy in redux to the OPEN WALLET, not to the window.
//
// Redux holds the live values the UI edits, but redux-persist writes them into
// the per-window localForage partition, which is minted fresh on every window
// open. So the wallet's own settings are loaded from durable per-wallet storage
// when it opens, and written back when the user changes them — redux stays the
// working copy, the wallet owns the truth.

import { useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import {
  selectAutoFuseEnabled,
  selectCashFusionEnabled,
  selectFuseDepth,
  selectP2pFusionEnabled,
  setAutoFuseEnabled,
  setCashFusionEnabled,
  setFuseDepth,
  setP2pFusionEnabled,
} from '../../state/slices/experimentalSlice';
import type { RootState } from '../../state/store';
import {
  readWalletFusionPolicy,
  writeWalletFusionPolicy,
} from './walletFusionPolicy';

export function useWalletFusionPolicy(): void {
  const dispatch = useDispatch();
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const cashFusionEnabled = useSelector(selectCashFusionEnabled);
  const autoFuseEnabled = useSelector(selectAutoFuseEnabled);
  const p2pFusionEnabled = useSelector(selectP2pFusionEnabled);
  const fuseDepth = useSelector(selectFuseDepth);

  /**
   * The wallet whose policy redux currently reflects.
   *
   * Loading a policy dispatches, and those dispatches would immediately look
   * like user edits to the writer below — writing the values straight back, and
   * on a wallet switch briefly writing the OLD wallet's settings onto the NEW
   * one. The writer therefore only runs once redux is known to be showing this
   * wallet.
   */
  const loadedFor = useRef<number | null>(null);

  useEffect(() => {
    if (walletId <= 0) {
      loadedFor.current = null;
      return;
    }
    if (loadedFor.current === walletId) return;

    const policy = readWalletFusionPolicy(walletId);
    dispatch(setCashFusionEnabled(policy.cashFusionEnabled));
    dispatch(setAutoFuseEnabled(policy.autoFuseEnabled));
    dispatch(setP2pFusionEnabled(policy.p2pFusionEnabled));
    dispatch(setFuseDepth(policy.fuseDepth));
    loadedFor.current = walletId;
  }, [walletId, dispatch]);

  useEffect(() => {
    // Only persist edits made while redux is showing THIS wallet.
    if (walletId <= 0 || loadedFor.current !== walletId) return;
    writeWalletFusionPolicy(walletId, {
      cashFusionEnabled,
      autoFuseEnabled,
      p2pFusionEnabled,
      fuseDepth,
    });
  }, [
    walletId,
    cashFusionEnabled,
    autoFuseEnabled,
    p2pFusionEnabled,
    fuseDepth,
  ]);
}
