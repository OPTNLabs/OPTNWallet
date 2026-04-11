import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useSelector } from 'react-redux';
import BottomNavBar from './BottomNavBar';
import { selectWalletId } from '../redux/walletSlice';
import useOutboundTransactions from '../hooks/useOutboundTransactions';
import PendingOutboundPanel from './transaction/PendingOutboundPanel';

const Layout = () => {
  const [navBarHeight, setNavBarHeight] = useState(0);
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          paddingBottom: 'var(--navbar-height)',
        }}
      >
        {outboundTransactions.length > 0 && (
          <div className="px-4 pt-3">
            <PendingOutboundPanel
              records={outboundTransactions}
              refreshing={reconciling}
              onRefresh={() => {
                void refresh();
              }}
              onRelease={(txid) => {
                void release(txid);
              }}
              compact
            />
          </div>
        )}
        <Outlet />
      </div>

      <BottomNavBar setNavBarHeight={setNavBarHeight} />
    </div>
  );
};

export default Layout;
