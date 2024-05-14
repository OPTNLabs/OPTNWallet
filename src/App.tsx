import { Routes, Route } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import CreateWallet from "./pages/CreateWallet";
import ImportWallet from "./pages/ImportWallet";

function App() {
  return (
  <>
    <Routes>
      <Route path = "/" element = {<LandingPage/>}/>
      <Route path = "/createwallet" element = {<CreateWallet/>}/>
      <Route path = "/importwallet" element = {<ImportWallet/>}/>
    </Routes>
  </>
  )
}
export default App
