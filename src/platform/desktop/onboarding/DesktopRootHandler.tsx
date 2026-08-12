// Desktop override of src/pages/RootHandler.tsx.
//
// Upstream RootHandler auto-resumes the last-used wallet from persisted
// Redux state with zero re-authentication — fine on mobile, where the OS
// app-lock/biometric already gates the whole app before anything renders.
//
// On desktop, each wallet now has its OWN password-derived key (see
// DesktopWalletManager.ts). WalletKeyCache is RAM-only and resets on every
// process restart, so auto-resuming straight into `/home/:id` would try to
// decrypt that wallet's data under whatever key the app-gate happens to have
// cached — not this wallet's actual key. Always landing on the wallet
// picker instead means opening a wallet is always an explicit, authenticated
// step (matching Electron Cash), regardless of what was open last session.
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { ROUTE_PATHS } from '../../../navigation/routes';
import { resetWallet } from '../../../state/slices/walletSlice';

const DesktopRootHandler = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();

  useEffect(() => {
    // The per-wallet key lives only in RAM and is gone after a restart, so on
    // boot NO wallet is actually open. Clear the persisted currentWalletId too,
    // otherwise every background service keyed on it fires against a wallet
    // whose key isn't cached and spams "No wallet key in memory". Invariant:
    // currentWalletId > 0 iff a wallet's key is cached — set/cleared together.
    dispatch(resetWallet());
    navigate(ROUTE_PATHS.landing, { replace: true });
  }, [navigate, dispatch]);

  return null;
};

export default DesktopRootHandler;
