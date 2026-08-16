import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useSelector } from 'react-redux';
import BottomNavBar from './BottomNavBar';
import { selectWalletId } from '../state/slices/walletSlice';
import useOutboundTransactions from '../hooks/useOutboundTransactions';
import PendingOutboundPanel from './transaction/PendingOutboundPanel';
import WalletReconfigurationOverlay from './WalletReconfigurationOverlay';
import type { RootState } from '../state/store';

type LayoutProps = {
  viewerOnly?: boolean;
};

const Layout = ({ viewerOnly = false }: LayoutProps) => {
  const [navBarHeight, setNavBarHeight] = useState(0);
  const [isPendingOutboundPanelOpen, setIsPendingOutboundPanelOpen] =
    useState(true);
  const walletId = useSelector(selectWalletId);
  const walletOperationStatus = useSelector(
    (state: RootState) => state.walletReconfiguration.status
  );
  const { outboundTransactions, reconciling, refresh, release } =
    useOutboundTransactions(walletId);

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--navbar-height',
      `${navBarHeight}px`
    );
  }, [navBarHeight]);

  useEffect(() => {
    if (outboundTransactions.length > 0) {
      setIsPendingOutboundPanelOpen(true);
    }
  }, [outboundTransactions.length]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!viewerOnly &&
        outboundTransactions.length > 0 &&
        isPendingOutboundPanelOpen && (
          <PendingOutboundPanel
            records={outboundTransactions}
            refreshing={reconciling}
            onRefresh={() => {
              void refresh();
            }}
            onRelease={(txid) => {
              void release(txid);
            }}
            onClose={() => setIsPendingOutboundPanelOpen(false)}
            compact
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
