import { Routes, Route } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import CreateWallet from "./pages/CreateWallet";
import ImportWallet from "./pages/ImportWallet";
import Home from "./pages/Home";
import CreateTransactions from "./pages/CreateTransactions";
import Transaction from "./pages/Transaction";

function App() {
  return (
  <>
    <Routes>
      <Route path = "/" element = {<LandingPage/>}/>
      <Route path = "/home/:wallet_id" element = {<Home/>}/>
      <Route path = "/createwallet" element = {<CreateWallet/>}/>
      <Route path = "/importwallet" element = {<ImportWallet/>}/>
      <Route path = "/createtransaction/:sendAddress" element = {<CreateTransactions/>}/>
      <Route path = "/transaction/" element = {<Transaction/>}/>
    </Routes>
  </>
  )
}
export default App
