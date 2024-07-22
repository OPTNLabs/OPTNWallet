// src/App.tsx
import { Routes, Route } from 'react-router-dom';
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

function App() {
  return (
    <Routes>
      <Route path="/" element={<RootHandler />} />
      <Route element={<Layout />}>
        <Route path="/home/:wallet_id" element={<Home />} />
        <Route path="/contract" element={<ContractView />} />
        <Route path="/contractsetup" element={<ContractTransactionPage />} />
        <Route path="/transaction" element={<Transaction />} />
        <Route
          path="/transactions/:wallet_id"
          element={<TransactionHistory />}
        />{' '}
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="/createwallet" element={<CreateWallet />} />
      <Route path="/importwallet" element={<ImportWallet />} />
    </Routes>
  );
}

export default App;
