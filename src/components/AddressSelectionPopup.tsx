import React, { useState, useEffect } from 'react';
import KeyService from '../services/KeyService';
import { shortenTxHash } from '../utils/shortenHash';
import { PREFIX } from '../utils/constants';
import { useSelector } from 'react-redux';
import { RootState } from '../state/store';
import { selectCurrentNetwork } from '../state/selectors/networkSelectors';
import { selectWalletId } from '../state/slices/walletSlice';
import Popup from './transaction/Popup';
import { useI18n } from '../i18n/useI18n';

interface AddressSelectionPopupProps {
  onSelect: (address: string) => void;
  onClose: () => void;
}

interface SelectableAddress {
  id: number;
  address: string;
}

const AddressSelectionPopup: React.FC<AddressSelectionPopupProps> = ({
  onSelect,
  onClose,
}) => {
  const [addresses, setAddresses] = useState<SelectableAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadIndex, setReloadIndex] = useState(0);
  const { t } = useI18n();
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const walletId = useSelector(selectWalletId);

  useEffect(() => {
    let active = true;
    const fetchAddresses = async () => {
      setLoading(true);
      setLoadFailed(false);
      if (walletId <= 0) {
        setAddresses([]);
        setLoading(false);
        return;
      }
      try {
        const keys = await KeyService.retrieveKeys(walletId);
        if (active) {
          setAddresses(
            keys.map((key) => ({
              id: key.id,
              address: key.address,
            }))
          );
        }
      } catch (error) {
        console.error('Address selection failed to load saved addresses.');
        if (active) {
          setAddresses([]);
          setLoadFailed(true);
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void fetchAddresses();
    return () => {
      active = false;
    };
  }, [walletId, reloadIndex]);

  const handleSelect = (address: string) => {
    // console.log('Address clicked:', address); // Debugging log
    onSelect(address); // Pass selected address to parent
  };

  return (
    <Popup
      closePopups={onClose}
      closeButtonText={t('contractPopup.back')}
      closeButtonClassName="wallet-btn-secondary w-full my-2"
      ariaLabel={t('contractPopup.selectAddress')}
    >
      <h2 className="mb-4 flex flex-col items-center text-xl font-bold">
        {t('contractPopup.selectAddress')}
      </h2>
      {loading ? (
        <p className="py-4 text-center" role="status">
          {t('send.loading')}
        </p>
      ) : loadFailed ? (
        <div className="space-y-3 py-4 text-center" role="alert">
          <p>{t('contractPopup.fetchFailed')}</p>
          <button
            type="button"
            className="wallet-btn-secondary mx-auto min-h-[44px] px-4"
            onClick={() => setReloadIndex((value) => value + 1)}
          >
            {t('builder.tryAgain')}
          </button>
        </div>
      ) : addresses.length === 0 ? (
        <p className="py-4 text-center wallet-muted">
          {t('contractPopup.noAddressesAvailable')}
        </p>
      ) : (
        <div className="mb-4 max-h-64 overflow-y-auto overscroll-contain touch-pan-y pr-1">
          <ul>
            {addresses.map((addr) => {
              const shortAddress = shortenTxHash(
                addr.address,
                PREFIX[currentNetwork].length
              );
              return (
                <li key={addr.id} className="mb-2">
                  <button
                    type="button"
                    className="wallet-card flex min-h-[44px] w-full flex-col items-center break-words p-2 text-left hover:brightness-[0.98]"
                    onClick={() => handleSelect(addr.address)}
                    aria-label={`${t('contractPopup.selectAddress')}: ${shortAddress}`}
                  >
                    {shortAddress}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Popup>
  );
};

export default AddressSelectionPopup;
