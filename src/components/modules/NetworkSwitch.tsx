import { Network } from '../../redux/networkSlice';

const NetworkSwitch = ({ networkType, setNetworkType }) => {
  const handleToggle = () => {
    setNetworkType(
      networkType === Network.CHIPNET ? Network.MAINNET : Network.CHIPNET
    );
  };

  return (
    <div className="flex flex-row gap-2 items-center text-white">
      <span>Chipnet</span>
      <div
        onClick={handleToggle}
        className={`w-12 h-6 rounded-full flex items-center cursor-pointer relative transition-colors ${
          networkType === Network.MAINNET ? 'bg-green-400' : 'bg-orange-400'
        }`}
      >
        <div
          className={`w-6 h-6 bg-white rounded-full shadow-md transform transition-transform ${
            networkType === Network.MAINNET ? 'translate-x-6' : 'translate-x-0'
          }`}
        />
      </div>
      <span>Mainnet</span>
    </div>
  );
};

export default NetworkSwitch;
