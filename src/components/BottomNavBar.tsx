// src/components/BottomNavBar.tsx

import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import { useEffect, useRef } from 'react';

const BottomNavBar = ({ setNavBarHeight }) => {
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  const navBarRef = useRef(null);

  useEffect(() => {
    if (navBarRef.current) {
      setNavBarHeight(navBarRef.current.offsetHeight);
    }
  }, [setNavBarHeight]);

  return (
    <nav
      className="fixed bottom-0 w-full bg-gray-800 text-white flex justify-around items-center py-4"
      id="bottomNavBar"
      ref={navBarRef}
    >
      <Link to={`/home/${walletId}`} className="flex flex-col items-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M3 9L12 2L21 9V20C21 20.5523 20.5523 21 20 21H4C3.44772 21 3 20.5523 3 20V9Z"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M9 21V12H15V21"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        <span>Home</span>
      </Link>
      <Link
        to={`/transactions/${walletId}`}
        className="flex flex-col items-center"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M22 2L11 13"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M22 2L15 22L11 13L2 9L22 2Z"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        <span>History</span>
      </Link>
      <Link to="/transaction" className="flex flex-col items-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M22 2L11 13"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M22 2L15 22L11 13L2 9L22 2Z"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        <span>Transaction</span>
      </Link>
      <Link to="/settings" className="flex flex-col items-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M19.4 15.1C19.8 14.4 20.2 13.6 20.3 12.8C20.2 12 19.8 11.2 19.4 10.5L21 8L17 7L15.6 3L12.4 4.9C11.6 4.3 10.4 4.3 9.6 4.9L6.4 3L5 7L1 8L2.6 10.5C2.2 11.2 1.8 12 1.7 12.8C1.8 13.6 2.2 14.4 2.6 15.1L1 18L5 19L6.4 23L9.6 21.1C10.4 21.7 11.6 21.7 12.4 21.1L15.6 23L17 19L21 18L19.4 15.1ZM12 15.5C10.1 15.5 8.5 13.9 8.5 12C8.5 10.1 10.1 8.5 12 8.5C13.9 8.5 15.5 10.1 15.5 12C15.5 13.9 13.9 15.5 12 15.5Z"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>Settings</span>
      </Link>
    </nav>
  );
};

export default BottomNavBar;
