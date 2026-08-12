import { NavLink } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import { useNavBarHeight } from './navigation/useNavBarHeight';

interface BottomNavBarProps {
  setNavBarHeight: (height: number) => void;
}

const BottomNavBar: React.FC<BottomNavBarProps> = ({ setNavBarHeight }) => {
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const { navBarRef } = useNavBarHeight({ setNavBarHeight });
  const navItemClass = ({ isActive }: { isActive: boolean }) =>
    `wallet-nav-item ${isActive ? 'wallet-nav-item-active' : ''}`;

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 w-full wallet-nav-gradient py-3"
      id="bottomNavBar"
      ref={navBarRef}
    >
      <div className="mx-auto flex max-w-md items-center justify-around px-2">
        <NavLink to={`/home/${walletId}`} className={navItemClass}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M3 9L12 2L21 9V20C21 20.5523 20.5523 21 20 21H4C3.44772 21 3 20.5523 3 20V9Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M9 21V12H15V21"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Home</span>
        </NavLink>

        <NavLink to="/assets" className={navItemClass}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M12 2C7 2 4 4.5 4 8v8c0 3.5 3 6 8 6s8-2.5 8-6V8c0-3.5-3-6-8-6Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M8 10h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span>Assets</span>
        </NavLink>

        <NavLink to="/actions" className={navItemClass}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M12 3v18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d="M7 8l5-5 5 5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Actions</span>
        </NavLink>

        <NavLink to="/apps" className={navItemClass}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="4" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="2" />
            <rect x="14" y="4" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="2" />
            <rect x="4" y="14" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="2" />
            <rect x="14" y="14" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="2" />
          </svg>
          <span>Apps</span>
        </NavLink>

        <NavLink to="/settings" className={navItemClass}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M19.4 15.1C19.8 14.4 20.2 13.6 20.3 12.8C20.2 12 19.8 11.2 19.4 10.5L21 8L17 7L15.6 3L12.4 4.9C11.6 4.3 10.4 4.3 9.6 4.9L6.4 3L5 7L1 8L2.6 10.5C2.2 11.2 1.8 12 1.7 12.8C1.8 13.6 2.2 14.4 2.6 15.1L1 18L5 19L6.4 23L9.6 21.1C10.4 21.7 11.6 21.7 12.4 21.1L15.6 23L17 19L21 18L19.4 15.1ZM12 15.5C10.1 15.5 8.5 13.9 8.5 12C8.5 10.1 10.1 8.5 12 8.5C13.9 8.5 15.5 10.1 15.5 12C15.5 13.9 13.9 15.5 12 15.5Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Settings</span>
        </NavLink>
      </div>
    </nav>
  );
};

export default BottomNavBar;
