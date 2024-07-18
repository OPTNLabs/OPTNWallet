// src/App.tsx
import { Routes, Route } from 'react-router-dom';
import CreateWallet from './pages/CreateWallet';
import ImportWallet from './pages/ImportWallet';
import Home from './pages/Home';
// import CreateTransactions from './pages/CreateTransactions';
import Transaction from './pages/Transaction';
import TransactionHistory from './pages/TransactionHistory';
import ContractView from './pages/ContractView';
import RootHandler from './pages/RootHandler';
import Layout from './components/Layout';
import Settings from './pages/Settings';

function App() {
  return (
    <Routes>
      <Route path="/" element={<RootHandler />} />
      <Route element={<Layout />}>
        <Route path="/home/:wallet_id" element={<Home />} />
        <Route path="/contract" element={<ContractView />} />
        {/* <Route path="/createtransaction/:sendAddress" element={<CreateTransactions />} /> */}
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
