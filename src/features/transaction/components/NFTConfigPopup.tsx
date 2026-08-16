import React from 'react';
import Popup from './Popup';
import type { TokenCapability } from '../../../services/cashtokens';
import { useI18n } from '../../../i18n/useI18n';

interface NFTConfigPopupProps {
  show: boolean;
  setShow: (value: boolean) => void;
  nftCapability: undefined | TokenCapability;
  setNftCapability: (value: undefined | TokenCapability) => void;
  nftCommitment: string;
  setNftCommitment: (value: string) => void;
}

const NFTConfigPopup: React.FC<NFTConfigPopupProps> = ({
  show,
  setShow,
  nftCapability,
  setNftCapability,
  nftCommitment,
  setNftCommitment,
}) => {
  const { t } = useI18n();
  if (!show) return null;
  return (
    <Popup closePopups={() => setShow(false)}>
      <div className="p-4">
        <h3 className="text-lg font-semibold mb-2">{t('nftConfig.title')}</h3>
        <div className="mb-2">
          <label className="block font-medium mb-1">
            {t('nftConfig.capability')}
          </label>
          <select
            value={nftCapability}
            onChange={(e) =>
              setNftCapability(e.target.value as undefined | TokenCapability)
            }
            className="wallet-input p-2 w-full"
          >
            <option value="none">{t('nftConfig.none')}</option>
            <option value="mutable">{t('nftConfig.mutable')}</option>
            <option value="minting">{t('nftConfig.minting')}</option>
          </select>
          <div className="mt-2 text-xs wallet-muted space-y-1">
            <p>
              <strong>{t('nftConfig.none')}</strong>:{' '}
              {t('nftConfig.noneDescription')}
            </p>
            <p>
              <strong>{t('nftConfig.mutable')}</strong>:{' '}
              {t('nftConfig.mutableDescription')}
            </p>
            <p>
              <strong>{t('nftConfig.minting')}</strong>:{' '}
              {t('nftConfig.mintingDescription')}
            </p>
          </div>
        </div>
        <div className="mb-2">
          <label className="block font-medium mb-1">
            {t('nftConfig.commitment')}
          </label>
          <input
            type="text"
            value={nftCommitment}
            onChange={(e) => setNftCommitment(e.target.value)}
            placeholder={t('nftConfig.placeholder')}
            className="wallet-input p-2 w-full break-words whitespace-normal"
          />
        </div>
        <button
          onClick={() => setShow(false)}
          className="wallet-btn-primary font-bold py-1 px-3"
        >
          {t('nftConfig.done')}
        </button>
      </div>
    </Popup>
  );
};

export default NFTConfigPopup;
