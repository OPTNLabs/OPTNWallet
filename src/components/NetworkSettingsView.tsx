// @ts-nocheck
import React from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../redux/store';
import { setNetwork, Network } from '../redux/networkSlice';

const NetworkSettingsView = () => {
  const dispatch: AppDispatch = useDispatch();
  const currentNetwork = useSelector(
    (state: RootState) => state.network.currentNetwork
  );

  const handleNetworkChange = (network: Network) => {
    dispatch(setNetwork(network));
  };

  return (
    <div className="overflow-y-auto h-full">
      <div className="p-4 rounded-lg bg-gray-100">
        <label className="block mb-2">Select Network:</label>
        <select
          value={currentNetwork}
          onChange={(e) => handleNetworkChange(e.target.value as Network)}
          className="border p-2 rounded"
        >
          <option value={Network.CHIPNET}>Chipnet</option>
          <option value={Network.MAINNET}>Mainnet</option>
        </select>
      </div>
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome2.png"
          alt="Welcome"
          className="max-w-full h-auto"
        />
      </div>
    </div>
  );
};

export default NetworkSettingsView;
