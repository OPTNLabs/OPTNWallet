// src/App.tsx
import { Routes, Route, Navigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import Layout from './components/Layout';
import RootHandler from './pages/RootHandler';
import Home from './pages/Home';
import CreateWallet from './pages/CreateWallet';
import ContractTransactionPage from './pages/ContractTransactionPage';
import ContractView from './pages/ContractView';
import ImportWallet from './pages/ImportWallet';
import Settings from './pages/Settings';
import Transaction from './pages/Transaction';
import TransactionHistory from './pages/TransactionHistory';
import LandingPage from './pages/LandingPage'; // Import the LandingPage
import { RootState } from './redux/store';

function App() {
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  return (
    <Routes>
      <Route path="/" element={<RootHandler />} />{' '}
      {/* Default route to handle logic */}
      {walletId === 1 ? (
        // Routes accessible when walletId is 1
        <>
          <Route element={<Layout />}>
            <Route path="/home/:wallet_id" element={<Home />} />
            <Route path="/contract" element={<ContractView />} />
            <Route
              path="/contractsetup"
              element={<ContractTransactionPage />}
            />
            <Route path="/transaction" element={<Transaction />} />
            <Route
              path="/transactions/:wallet_id"
              element={<TransactionHistory />}
            />
            <Route path="/settings" element={<Settings />} />
          </Route>
          {/* Redirect / to /home/${walletId} when walletId is 1 */}
          <Route
            path="/"
            element={<Navigate to={`/home/${walletId}`} replace />}
          />
          <Route
            path="*"
            element={<Navigate to={`/home/${walletId}`} replace />}
          />
        </>
      ) : (
        // Routes accessible when walletId is not 1
        <>
          <Route path="/landing" element={<LandingPage />} />
          <Route path="/createwallet" element={<CreateWallet />} />
          <Route path="/importwallet" element={<ImportWallet />} />
          {/* Redirect all other routes to /landing */}
          <Route path="*" element={<Navigate to="/landing" replace />} />
        </>
      )}
    </Routes>
  );
}

export default App;
