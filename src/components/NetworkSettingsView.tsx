// import { useSelector, useDispatch } from 'react-redux';
// import { RootState, AppDispatch } from '../redux/store';
// import { setNetwork, Network } from '../redux/networkSlice';

const NetworkSettingsView = () => {
  // const dispatch: AppDispatch = useDispatch();
  // const currentNetwork = useSelector(
  //   (state: RootState) => state.network.currentNetwork
  // );

  // const handleNetworkChange = (network: Network) => {
  //   dispatch(setNetwork(network));
  // };

  return (
    <div className="h-5/6">
      {/* <div className="p-4 rounded-lg bg-gray-100">
        <label className="block mb-2">Select Network:</label>
        <select
          value={currentNetwork}
          onChange={(e) => handleNetworkChange(e.target.value as Network)}
          className="border p-2 rounded"
        >
          <option value={Network.CHIPNET}>Chipnet</option>
          <option value={Network.MAINNET}>Mainnet</option>
        </select>
      </div> */}
      <div className="p-4 rounded-lg">
        <a
          href="https://tbch.googol.cash/"
          className="text-blue-600"
          target="_blank"
          rel="noopener noreferrer"
        >
          Testnet Faucet - https://tbch.googol.cash
        </a>
        <p className="mt-4 font-semibold">Instructions</p>
        <ol className="list-decimal ml-6">
          <li>Copy a BCH testnet address</li>
          <li>Click the Testnet Faucet link</li>
          <li>Select "chipnet" in the NETWORK box</li>
          <li>Paste your address</li>
          <li>Answer the captcha question</li>
          <li>Press "Get Coins"</li>
        </ol>
      </div>
      <div className="flex justify-center items-base line mt-4">
        <img
          src="/assets/images/OPTNWelcome3.png"
          alt="Welcome"
          className="max-w-full h-auto"
          width={'75%'}
          height={'75%'}
        />
      </div>
    </div>
  );
};

export default NetworkSettingsView;
