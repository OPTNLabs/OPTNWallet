import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import BottomNavBar from './BottomNavBar';

const Layout = () => {
  const [navBarHeight, setNavBarHeight] = useState(0);

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--navbar-height',
      `${navBarHeight}px`
    );
  }, [navBarHeight]);

  return (
    <div className="flex flex-col min-h-[100dvh]">
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          paddingBottom: `calc(var(--navbar-height) + var(--safe-bottom))`,
        }}
      >
        <Outlet />
      </div>

      {/* Ensure the bar accounts for safe area */}
      <div className="safe-area-bottom">
        <BottomNavBar setNavBarHeight={setNavBarHeight} />
      </div>
    </div>
  );
};

export default Layout;
