import React from 'react';
import { FaCamera } from 'react-icons/fa';
import { UTXO } from '../../../types/types';
import { DUST } from '../../../utils/constants';
import type { BcmrTokenMetadataState } from '../../../types/bcmr';
import { resolveTokenPresentation } from '../../../utils/tokenPresentation';
import type { TokenPresentationFallback } from '../../../utils/tokenPresentation';
import TokenIdentityBadge from '../../../components/ui/TokenIdentityBadge';
import { useI18n } from '../../../i18n/useI18n';

interface CashTokenViewProps {
  recipientAddress: string;
  setRecipientAddress: (address: string) => void;
  transferAmount: number;
  handleTransferAmountChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  tokenAmount: number | bigint;
  handleTokenAmountChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  selectedTokenCategory: string;
  setSelectedTokenCategory: (category: string) => void;
  selectedUtxos: UTXO[];
  scanBarcode: () => void;
  handleAddOutput: () => void;
  selectedTokenMetadata?: BcmrTokenMetadataState | null;
  selectedTokenFallback?: TokenPresentationFallback | null;
}

const CashTokenView: React.FC<CashTokenViewProps> = ({
  recipientAddress,
  setRecipientAddress,
  transferAmount,
  handleTransferAmountChange,
  tokenAmount,
  handleTokenAmountChange,
  selectedTokenCategory,
  setSelectedTokenCategory,
  selectedUtxos,
  scanBarcode,
  handleAddOutput,
  selectedTokenMetadata = null,
  selectedTokenFallback = null,
}) => {
  const { t } = useI18n();
  const presentation = resolveTokenPresentation(
    selectedTokenCategory || 'cash-token',
    selectedTokenMetadata,
    selectedTokenFallback ?? { name: 'CashToken', symbol: 'token' }
  );
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <TokenIdentityBadge
          presentation={presentation}
          detail={<span className="text-sm font-medium wallet-muted">FT</span>}
          showStatus
        />
      </div>
      <label className="block font-medium mb-1">
        {t('builder.recipientAddress')}
      </label>
      <div className="flex items-center mb-2">
        <input
          type="text"
          value={recipientAddress}
          onChange={(e) => setRecipientAddress(e.target.value)}
          className="wallet-input p-2 w-full break-words whitespace-normal"
        />
        <button
          onClick={scanBarcode}
          className="ml-2 wallet-btn-primary p-2"
          title={t('builder.scanQrCode')}
        >
          <FaCamera />
        </button>
      </div>
      <div className="mb-2">
        <label className="block font-medium mb-1">
          {t('builder.bchAmountSats')}
        </label>
        <input
          type="number"
          value={transferAmount}
          onChange={handleTransferAmountChange}
          className="wallet-input p-2 w-full break-words whitespace-normal"
          min={DUST}
        />
      </div>
      <div className="mb-2">
        <label className="block font-medium mb-1">
          {t('builder.tokenAmount')}
        </label>
        <input
          type="number"
          value={
            typeof tokenAmount === 'bigint'
              ? tokenAmount.toString()
              : String(tokenAmount ?? '')
          }
          onChange={handleTokenAmountChange}
          className="wallet-input p-2 w-full break-words whitespace-normal"
        />
      </div>
      <div className="mb-2">
        <label className="block font-medium mb-1">
          {t('builder.genesisInput')}
        </label>
        <select
          value={selectedTokenCategory}
          onChange={(e) => setSelectedTokenCategory(e.target.value)}
          className="wallet-input p-2 w-full break-words whitespace-normal"
        >
          <option value="">{t('builder.selectGenesisInput')}</option>
          {selectedUtxos
            .filter((utxo) => !utxo.token && utxo.tx_pos === 0)
            .map((utxo, index) => (
              <option key={utxo.tx_hash + index} value={utxo.tx_hash}>
                {utxo.tx_hash}
              </option>
            ))}
        </select>
      </div>
      <div className="flex justify-end mt-4">
        <button
          onClick={handleAddOutput}
          className="wallet-btn-primary font-bold py-2 px-4"
        >
          {t('builder.addRecipient')}
        </button>
      </div>
    </>
  );
};

export default CashTokenView;
