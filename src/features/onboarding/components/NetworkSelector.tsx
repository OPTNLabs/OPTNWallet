import { useDispatch } from 'react-redux';
import { Network, setNetwork } from '../../../state/slices/networkSlice';
import NetworkSwitch from '../../../components/modules/NetworkSwitch';
import InfoTooltipIcon from './InfoTooltipIcon';
import { useI18n } from '../../../i18n/useI18n';

type NetworkSelectorProps = {
  networkType: Network;
  centered?: boolean;
};

const NetworkSelector = ({
  networkType,
  centered = false,
}: NetworkSelectorProps) => {
  const dispatch = useDispatch();
  const { t } = useI18n();

  return (
    <div
      className={`flex items-center gap-2 mb-4 ${
        centered ? 'justify-center w-full' : ''
      }`}
    >
      <NetworkSwitch
        networkType={networkType}
        setNetworkType={(nextNetwork: Network) =>
          dispatch(setNetwork(nextNetwork))
        }
      />
      <InfoTooltipIcon
        id="network-tooltip"
        content={t('derivation.walletNetworkDescription')}
        className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
        iconClassName="cursor-pointer wallet-link text-lg font-bold select-none"
        ariaLabel={t('derivation.walletNetwork')}
      />
    </div>
  );
};

export default NetworkSelector;
