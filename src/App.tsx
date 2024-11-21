// src/App.tsx
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { useEffect } from 'react';
import Layout from './components/Layout';
import RootHandler from './pages/RootHandler';
import Home from './pages/Home';
import CreateWallet from './pages/CreateWallet';
import ContractView from './pages/ContractView';
import ImportWallet from './pages/ImportWallet';
import Settings from './pages/Settings';
import Transaction from './pages/Transaction';
import TransactionHistory from './pages/TransactionHistory';
import LandingPage from './pages/LandingPage';
import Receive from './pages/Receive';
import { RootState } from './redux/store';
import { startUTXOWorker, stopUTXOWorker } from './workers/UTXOWorkerService';
import {
  startTransactionWorker,
  stopTransactionWorker,
} from './workers/TransactionWorkerService';

let utxoWorkerStarted = false;
let transactionWorkerStarted = false;

function App() {
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const location = useLocation();

  useEffect(() => {
    if (walletId === 1) {
      // Start the UTXO and Transaction workers if walletId is 1 and workers aren't already started
      if (!utxoWorkerStarted) {
        startUTXOWorker();
        utxoWorkerStarted = true;
      }
      if (!transactionWorkerStarted) {
        startTransactionWorker();
        transactionWorkerStarted = true;
      }
    } else {
      // Stop workers if walletId is not 1
      if (utxoWorkerStarted) {
        stopUTXOWorker();
        utxoWorkerStarted = false;
      }
      if (transactionWorkerStarted) {
        stopTransactionWorker();
        transactionWorkerStarted = false;
      }
    }

    // Cleanup function
    return () => {
      if (walletId !== 1) {
        if (utxoWorkerStarted) {
          stopUTXOWorker();
          utxoWorkerStarted = false;
        }
        if (transactionWorkerStarted) {
          stopTransactionWorker();
          transactionWorkerStarted = false;
        }
      }
    };
  }, [walletId, location.pathname]);

  return (
    <Routes>
      <Route path="/" element={<RootHandler />} />
      {walletId === 1 ? (
        <>
          <Route element={<Layout />}>
            <Route path="/home/:wallet_id" element={<Home />} />
            <Route path="/contract" element={<ContractView />} />
            <Route path="/receive" element={<Receive />} />
            <Route path="/transaction" element={<Transaction />} />
            <Route
              path="/transactions/:wallet_id"
              element={<TransactionHistory />}
            />
            <Route path="/settings" element={<Settings />} />
          </Route>
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
        <>
          <Route path="/landing" element={<LandingPage />} />
          <Route path="/createwallet" element={<CreateWallet />} />
          <Route path="/importwallet" element={<ImportWallet />} />
          <Route path="*" element={<Navigate to="/landing" replace />} />
        </>
      )}
    </Routes>
  );
}

export default App;
