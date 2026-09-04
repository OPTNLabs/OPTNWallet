import { useEffect, useState } from 'react';
import {
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import WalletManager from '../../apis/WalletManager/WalletManager';
import BottomNavBar from '../../components/BottomNavBar';
import {
  selectWalletId,
  setWalletDerivationPath,
  setWalletId,
  setWalletNetwork,
  setWalletType,
} from '../../state/slices/walletSlice';
import { WalletType } from '../../types/wallet';
import { homeRoute, multisigRoute } from '../../navigation/routes';
import { Network, setNetwork } from '../../state/slices/networkSlice';
import MultisigBackButton from './MultisigBackButton';
import useOutboundTransactions from '../../hooks/useOutboundTransactions';
import PendingOutboundPanel from '../transaction/components/PendingOutboundPanel';

export default function MultisigLayout() {
  const { wallet_id: routeWalletId } = useParams();
  const standardWalletId = useSelector(selectWalletId);
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const routeId = Number(routeWalletId);
  const isHome = location.pathname === multisigRoute(routeId);
  const [navBarHeight, setNavBarHeight] = useState(0);
  const [routeWalletValid, setRouteWalletValid] = useState<boolean | null>(
    null
  );
  const [isPendingPanelOpen, setIsPendingPanelOpen] = useState(true);
  const { outboundTransactions, reconciling, refresh, release } =
    useOutboundTransactions(routeWalletValid ? routeId : null);

  useEffect(() => {
    if (outboundTransactions.length > 0) setIsPendingPanelOpen(true);
  }, [outboundTransactions.length]);

  useEffect(() => {
    let cancelled = false;
    setRouteWalletValid(null);
    void WalletManager()
      .getWalletMetadata(routeId)
      .then(async (metadata) => {
        if (cancelled) return;
        const valid = metadata?.walletType === WalletType.MULTISIG;
        setRouteWalletValid(valid);
        if (!valid || standardWalletId === routeId) return;

        // Repair sessions created by the old implementation. A workspace
        // route must never make the policy wallet the app's standard wallet.
        const standard = (await WalletManager().getAllWallets()).find(
          (wallet) => wallet.walletType === WalletType.STANDARD
        );
        if (cancelled || !standard) return;
        const standardMetadata = await WalletManager().getWalletMetadata(
          standard.id
        );
        if (cancelled) return;
        const network =
          standardMetadata?.networkType ??
          standard.networkType ??
          Network.MAINNET;
        dispatch(setWalletId(standard.id));
        dispatch(setWalletNetwork(network));
        dispatch(setNetwork(network));
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
      })
      .catch(() => {
        if (!cancelled) setRouteWalletValid(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch, routeId, standardWalletId]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--navbar-height',
      `${navBarHeight}px`
    );

    return () => {
      document.documentElement.style.setProperty('--navbar-height', '0px');
    };
  }, [navBarHeight]);

  if (!Number.isSafeInteger(routeId) || routeId <= 0) {
    return (
      <Navigate
        to={standardWalletId > 0 ? homeRoute(standardWalletId) : '/landing'}
        replace
      />
    );
  }

  if (routeWalletValid === false) {
    return (
      <Navigate
        to={standardWalletId > 0 ? homeRoute(standardWalletId) : '/landing'}
        replace
      />
    );
  }

  if (routeWalletValid === null) return null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--wallet-bg)]">
      {outboundTransactions.length > 0 && isPendingPanelOpen && (
        <PendingOutboundPanel
          records={outboundTransactions}
          refreshing={reconciling}
          onRefresh={() => void refresh()}
          onRelease={(txid) => void release(txid)}
          onClose={() => setIsPendingPanelOpen(false)}
          compact
        />
      )}
      <header className="shrink-0 border-b border-[var(--wallet-border)] px-4 pb-3 pt-[calc(var(--safe-top)+0.75rem)]">
        <div className="mx-auto flex w-full max-w-2xl items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--wallet-accent-strong)]">
              OPTN multisig workspace
            </p>
            <h1 className="mt-1 text-lg font-bold wallet-text-strong">
              Shared policy wallet
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isHome && (
              <MultisigBackButton
                onClick={() =>
                  navigate(
                    standardWalletId > 0
                      ? homeRoute(standardWalletId)
                      : '/landing'
                  )
                }
              />
            )}
            <button
              type="button"
              className="rounded-xl border border-[var(--wallet-border)] px-3 py-2 text-xs font-semibold wallet-text-strong"
              onClick={() => navigate(multisigRoute(routeId, 'policy'))}
            >
              Policy
            </button>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>

      <BottomNavBar setNavBarHeight={setNavBarHeight} />
    </div>
  );
}
