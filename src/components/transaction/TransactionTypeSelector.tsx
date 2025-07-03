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
        className={`font-bold py-1 px-2 rounded ${
          showRegularTx ? 'bg-blue-600 text-white' : 'bg-blue-200 text-gray-800'
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
        className={`font-bold py-1 px-2 rounded ${
          showOpReturn ? 'bg-yellow-400 text-white' : 'bg-yellow-200 text-gray-800'
        } hover:bg-yellow-500`}
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
            className={`font-bold py-1 px-2 rounded ${
              showCashToken ? 'bg-orange-500 text-white' : 'bg-orange-200 text-gray-800'
            } hover:bg-orange-600`}
          >
            Create CashToken
          </button>
          <button
            onClick={() => {
              resetFormValues();
              setShowNFTCashToken(true);
              setPopupTitle('Create NFT');
            }}
            className={`font-bold py-1 px-2 rounded ${
              showNFTCashToken ? 'bg-pink-500 text-white' : 'bg-pink-200 text-gray-800'
            } hover:bg-pink-600`}
          >
            Create NFT
          </button>
        </>
      )}
    </div>
  );
};

export default TransactionTypeSelector;