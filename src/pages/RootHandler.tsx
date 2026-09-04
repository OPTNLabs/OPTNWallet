// src/pages/RootHandler.tsx

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import WalletManager from '../apis/WalletManager/WalletManager';
import { Network, setNetwork } from '../state/slices/networkSlice';
import {
  selectHasWallet,
  selectWalletId,
  selectWalletType,
  setWalletDerivationPath,
  setWalletId,
  setWalletNetwork,
  setWalletType,
} from '../state/slices/walletSlice';
import { WalletType } from '../types/wallet';
import { homeRoute, ROUTE_PATHS } from '../navigation/routes';
import { multisigRoute } from '../navigation/routes';

const RootHandler = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const walletId = useSelector(selectWalletId);
  const walletType = useSelector(selectWalletType);
  const hasWallet = useSelector(selectHasWallet);

  useEffect(() => {
    let cancelled = false;

    const restoreDefaultWallet = async () => {
      if (!hasWallet) {
        navigate(ROUTE_PATHS.landing, { replace: true });
        return;
      }

      const manager = WalletManager();
      const active = await manager.getWalletMetadata(walletId);
      if (cancelled) return;

      // A multisig policy is an additional wallet, not the mnemonic wallet's
      // replacement. If an older session persisted a multisig as active, put
      // the standard signing wallet back in the default mobile/web session.
      if (active?.walletType === WalletType.MULTISIG) {
        const standard = (await manager.getAllWallets()).find(
          (wallet) => wallet.walletType === WalletType.STANDARD
        );
        if (cancelled) return;
        if (standard) {
          const standardMetadata = await manager.getWalletMetadata(standard.id);
          if (cancelled) return;
          const standardNetwork =
            standardMetadata?.networkType ??
            standard.networkType ??
            Network.MAINNET;
          dispatch(setWalletId(standard.id));
          dispatch(setWalletNetwork(standardNetwork));
          dispatch(
            setWalletType(standardMetadata?.walletType ?? standard.walletType)
          );
          if (standardMetadata?.derivation_path) {
            dispatch(
              setWalletDerivationPath({
                path: standardMetadata.derivation_path,
                source:
                  standardMetadata.derivation_path_source === 'custom'
                    ? 'custom'
                    : 'default',
              })
            );
          }
          dispatch(setNetwork(standardNetwork));
          navigate(homeRoute(standard.id), { replace: true });
          return;
        }

        // Descriptor-only installs have no mnemonic wallet to restore. Keep
        // the only available policy explicit rather than sending it through
        // the ordinary single-key home route.
        navigate(multisigRoute(walletId), { replace: true });
        return;
      }

      navigate(homeRoute(walletId), { replace: true });
    };

    void restoreDefaultWallet().catch(() => {
      if (!cancelled) {
        navigate(
          walletType === WalletType.MULTISIG
            ? multisigRoute(walletId)
            : homeRoute(walletId),
          { replace: true }
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [dispatch, hasWallet, navigate, walletId, walletType]);

  return null; // Render nothing since navigation handles redirection
};

export default RootHandler;
