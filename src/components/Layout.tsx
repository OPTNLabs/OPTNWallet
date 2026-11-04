import { useState, useEffect, useRef } from 'react';
import { Outlet } from 'react-router-dom';
import { useSelector } from 'react-redux';
import BottomNavBar from './BottomNavBar';
import { selectWalletId } from '../state/slices/walletSlice';
import useOutboundTransactions from '../hooks/useOutboundTransactions';
import PendingOutboundPanel from './transaction/PendingOutboundPanel';
import WalletReconfigurationOverlay from './WalletReconfigurationOverlay';
import type { RootState } from '../state/store';
import { useI18n } from '../i18n/useI18n';
import { useWalletConfirm } from './WalletConfirmDialog';
import { OUTBOUND_RELEASE_DELAY_MS } from '../services/OutboundTransactionTracker';

type LayoutProps = {
  viewerOnly?: boolean;
};

const Layout = ({ viewerOnly = false }: LayoutProps) => {
  const [navBarHeight, setNavBarHeight] = useState(0);
  const [isPendingOutboundPanelOpen, setIsPendingOutboundPanelOpen] =
    useState(true);
  const walletId = useSelector(selectWalletId);
  const { t } = useI18n();
  const confirm = useWalletConfirm();
  const walletOperationStatus = useSelector(
    (state: RootState) => state.walletReconfiguration.status
  );
  const { outboundTransactions, reconciling, refresh, release } =
    useOutboundTransactions(walletId);
  const pendingReleaseConfirmationInFlight = useRef(false);
  // Keep broadcasted records active for spend-lock safety and background
  // reconciliation, but stop presenting them as network-pending UI.
  const networkPendingOutboundTransactions = outboundTransactions.filter(
    (record) => record.state !== 'broadcasted'
  );

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--navbar-height',
      `${navBarHeight}px`
    );
  }, [navBarHeight]);

  useEffect(() => {
    if (networkPendingOutboundTransactions.length > 0) {
      setIsPendingOutboundPanelOpen(true);
    }
  }, [networkPendingOutboundTransactions.length]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!viewerOnly &&
        networkPendingOutboundTransactions.length > 0 &&
        isPendingOutboundPanelOpen && (
          <PendingOutboundPanel
            records={networkPendingOutboundTransactions}
            refreshing={reconciling}
            onRefresh={() => {
              void refresh();
            }}
            onRelease={(txid) => {
              if (pendingReleaseConfirmationInFlight.current) return;
              const record = networkPendingOutboundTransactions.find(
                (item) => item.txid === txid
              );
              if (!record) return;
              pendingReleaseConfirmationInFlight.current = true;
              const message =
                record.state === 'submitted'
                  ? t('outbox.clearPendingTitle')
                  : t('outbox.releaseStaleTitle', {
                      minutes: Math.round(OUTBOUND_RELEASE_DELAY_MS / 60000),
                    });
              void confirm(message)
                .then(async (confirmed) => {
                  if (confirmed) await release(txid);
                })
                .finally(() => {
                  pendingReleaseConfirmationInFlight.current = false;
                });
            }}
            onClose={() => setIsPendingOutboundPanelOpen(false)}
            compact
            blocking={false}
          />
        )}
      <div
        className="flex-1 min-h-0 overflow-hidden"
        aria-busy={walletOperationStatus === 'running'}
      >
        <Outlet />
      </div>
      <BottomNavBar
        setNavBarHeight={setNavBarHeight}
        disabled={walletOperationStatus === 'running'}
        viewerOnly={viewerOnly}
      />
      {!viewerOnly && <WalletReconfigurationOverlay />}
    </div>
  );
};

export default Layout;
