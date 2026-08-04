import React from 'react';
import { useI18n } from '../../../i18n/useI18n';

interface OpReturnViewProps {
  opReturnText: string;
  setOpReturnText: (value: string) => void;
  addOpReturnOutput: () => void;
}

const OpReturnView: React.FC<OpReturnViewProps> = ({
  opReturnText,
  setOpReturnText,
  addOpReturnOutput,
}) => {
  const { t } = useI18n();

  return (
    <>
      <label className="block font-medium mb-1">
        {t('builder.opReturnData')}
      </label>
      <textarea
        value={opReturnText}
        onChange={(e) => setOpReturnText(e.target.value)}
        placeholder={t('builder.opReturnPlaceholder')}
        className="wallet-input p-2 w-full break-words whitespace-normal h-32"
      />
      <div className="flex justify-end mt-4">
        <button
          onClick={addOpReturnOutput}
          className="wallet-btn-primary font-bold py-2 px-4"
        >
          {t('builder.addOpReturnOutput')}
        </button>
      </div>
    </>
  );
};

export default OpReturnView;
