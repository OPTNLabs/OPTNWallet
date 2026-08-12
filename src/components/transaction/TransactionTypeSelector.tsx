import React from 'react';

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
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      <button
        onClick={() => {
          resetFormValues();
          setShowRegularTx(true);
          setPopupTitle('Send Regular Transaction');
        }}
        className={`font-bold py-1 px-2 rounded border ${
          showRegularTx
            ? 'wallet-segment-active border-[var(--wallet-accent)]'
            : 'wallet-segment-inactive border-[var(--wallet-border)]'
        }`}
      >
        Create Output
      </button>
      <button
        onClick={() => {
          resetFormValues();
          setShowOpReturn(true);
          setPopupTitle('Create OP_RETURN Output');
        }}
        className={`font-bold py-1 px-2 rounded border ${
          showOpReturn
            ? 'wallet-segment-active border-[var(--wallet-accent)]'
            : 'wallet-segment-inactive border-[var(--wallet-border)]'
        }`}
      >
        Create OP_RETURN
      </button>
      {hasGenesisUtxoSelected && (
        <>
          <button
            onClick={() => {
              resetFormValues();
              setShowCashToken(true);
              setPopupTitle('Create CashToken');
            }}
            className={`font-bold py-1 px-2 rounded border ${
              showCashToken
                ? 'wallet-segment-active border-[var(--wallet-accent)]'
                : 'wallet-segment-inactive border-[var(--wallet-border)]'
            }`}
          >
            Create CashToken
          </button>
          <button
            onClick={() => {
              resetFormValues();
              setShowNFTCashToken(true);
              setPopupTitle('Create NFT');
            }}
            className={`font-bold py-1 px-2 rounded border ${
              showNFTCashToken
                ? 'wallet-segment-active border-[var(--wallet-accent)]'
                : 'wallet-segment-inactive border-[var(--wallet-border)]'
            }`}
          >
            Create NFT
          </button>
        </>
      )}
    </div>
  );
};

export default TransactionTypeSelector;
