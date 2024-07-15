// src/components/Layout.tsx

import React, { useState, useEffect } from 'react';
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
    <div className="min-h-screen flex flex-col">
      <div
        className="flex-grow"
        style={{ paddingBottom: `var(--navbar-height)` }}
      >
        <Outlet />
      </div>
      <BottomNavBar setNavBarHeight={setNavBarHeight} />
    </div>
  );
};

export default Layout;
