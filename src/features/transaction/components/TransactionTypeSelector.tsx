import React from 'react';
import { useI18n } from '../../../i18n/useI18n';

interface TransactionTypeSelectorProps {
  showRegularTx: boolean;
  setShowRegularTx: (value: boolean) => void;
  showCashToken: boolean;
  setShowCashToken: (value: boolean) => void;
  showNFTCashToken: boolean;
  setShowNFTCashToken: (value: boolean) => void;
  showOpReturn: boolean;
  setShowOpReturn: (value: boolean) => void;
  hasGenesisUtxoSelected: boolean;
  resetFormValues: () => void;
  setPopupTitle: (title: string) => void;
}

const TransactionTypeSelector: React.FC<TransactionTypeSelectorProps> = ({
  showRegularTx,
  setShowRegularTx,
  showCashToken,
  setShowCashToken,
  showNFTCashToken,
  setShowNFTCashToken,
  showOpReturn,
  setShowOpReturn,
  hasGenesisUtxoSelected,
  resetFormValues,
  setPopupTitle,
}) => {
  const { t } = useI18n();

  return (
    <div className="mb-2 flex flex-wrap gap-2">
      <button
        onClick={() => {
          resetFormValues();
          setShowRegularTx(true);
          setPopupTitle(t('builder.sendBch'));
        }}
        className={`font-bold py-1 px-2 rounded border ${
          showRegularTx
            ? 'wallet-segment-active border-[var(--wallet-accent)]'
            : 'wallet-segment-inactive border-[var(--wallet-border)]'
        }`}
      >
        {t('builder.sendBch')}
      </button>
      <button
        onClick={() => {
          resetFormValues();
          setShowOpReturn(true);
          setPopupTitle(t('builder.attachMessage'));
        }}
        className={`font-bold py-1 px-2 rounded border ${
          showOpReturn
            ? 'wallet-segment-active border-[var(--wallet-accent)]'
            : 'wallet-segment-inactive border-[var(--wallet-border)]'
        }`}
      >
        {t('builder.attachMessage')}
      </button>
      {hasGenesisUtxoSelected && (
        <>
          <button
            onClick={() => {
              resetFormValues();
              setShowCashToken(true);
              setPopupTitle(t('builder.createToken'));
            }}
            className={`font-bold py-1 px-2 rounded border ${
              showCashToken
                ? 'wallet-segment-active border-[var(--wallet-accent)]'
                : 'wallet-segment-inactive border-[var(--wallet-border)]'
            }`}
          >
            {t('builder.createToken')}
          </button>
          <button
            onClick={() => {
              resetFormValues();
              setShowNFTCashToken(true);
              setPopupTitle(t('builder.createCollectible'));
            }}
            className={`font-bold py-1 px-2 rounded border ${
              showNFTCashToken
                ? 'wallet-segment-active border-[var(--wallet-accent)]'
                : 'wallet-segment-inactive border-[var(--wallet-border)]'
            }`}
          >
            {t('builder.createCollectible')}
          </button>
        </>
      )}
    </div>
  );
};

export default TransactionTypeSelector;
