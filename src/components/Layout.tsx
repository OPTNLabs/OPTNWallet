import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useSelector } from 'react-redux';
import BottomNavBar from './BottomNavBar';
import { selectWalletId } from '../state/slices/walletSlice';
import useOutboundTransactions from '../hooks/useOutboundTransactions';
import PendingOutboundPanel from './transaction/PendingOutboundPanel';

const Layout = () => {
  const [navBarHeight, setNavBarHeight] = useState(0);
  const [isPendingOutboundPanelOpen, setIsPendingOutboundPanelOpen] = useState(true);
  const walletId = useSelector(selectWalletId);
  const {
    outboundTransactions,
    reconciling,
    refresh,
    release,
  } = useOutboundTransactions(walletId);

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
      {outboundTransactions.length > 0 && isPendingOutboundPanelOpen && (
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
      <div className="flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </div>
      <BottomNavBar setNavBarHeight={setNavBarHeight} />
    </div>
  );
};

export default Layout;
