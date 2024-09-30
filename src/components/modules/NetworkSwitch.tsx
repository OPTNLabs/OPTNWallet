import { Network } from '../../redux/networkSlice';

const NetworkSwitch = ({ networkType, setNetworkType }) => {
  return (
    <>
      <div
        onClick={() =>
          setNetworkType(
            networkType === Network.CHIPNET ? Network.MAINNET : Network.CHIPNET
          )
        }
        className="flex flex-row gap-2 text-white"
      >
        <span>Chipnet</span>
        <input
          className="w-8"
          type="range"
          min={0}
          max={1}
          value={networkType === Network.CHIPNET ? 0 : 1}
        />
        <span>Mainnet</span>
      </div>
    </>
  );
};

export default NetworkSwitch;
