import { useDispatch } from 'react-redux';
import { Network, setNetwork } from '../../../redux/networkSlice';
import NetworkSwitch from '../../../components/modules/NetworkSwitch';
import InfoTooltipIcon from './InfoTooltipIcon';

type NetworkSelectorProps = {
  networkType: Network;
  centered?: boolean;
};

const NETWORK_TOOLTIP_TEXT =
  'Select the blockchain network your wallet will connect to (e.g., Mainnet or CHIPNET Testnet).';

const NetworkSelector = ({
  networkType,
  centered = false,
}: NetworkSelectorProps) => {
  const dispatch = useDispatch();

  return (
    <div
      className={`flex items-center gap-2 mb-4 ${
        centered ? 'justify-center w-full' : ''
      }`}
    >
      <NetworkSwitch
        networkType={networkType}
        setNetworkType={(nextNetwork: Network) => dispatch(setNetwork(nextNetwork))}
      />
      <InfoTooltipIcon
        id="network-tooltip"
        content={NETWORK_TOOLTIP_TEXT}
        className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
        iconClassName="cursor-pointer wallet-link text-lg font-bold select-none"
        ariaLabel="Network information"
      />
    </div>
  );
};

export default NetworkSelector;
