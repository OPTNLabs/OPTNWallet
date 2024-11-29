// src/components/transaction/TransactionOutputsDisplay.tsx

import React from 'react';
import { TransactionOutput } from '../../types/types';

interface TransactionOutputsDisplayProps {
  txOutputs: TransactionOutput[];
  handleRemoveOutput: (index: number) => void;
}

const TransactionOutputsDisplay: React.FC<TransactionOutputsDisplayProps> = ({
  txOutputs,
  handleRemoveOutput,
}) => {
  return (
    <div className="mb-6">
      <h3 className="text-lg font-semibold mb-2">Transaction Outputs</h3>
      {txOutputs.map((output, index) => (
        <div
          key={index}
          className="flex flex-col items-start mb-2 w-full break-words whitespace-normal"
        >
          <span className="w-full">{`Recipient: ${output.recipientAddress}`}</span>
          <span className="w-full">{`Amount: ${output.amount.toString()}`}</span>
          {output.token && (
            <>
              <span className="w-full">{`Token: ${output.token.amount.toString()}`}</span>
              <span className="w-full">{`Category: ${output.token.category}`}</span>
            </>
          )}
          <button
            onClick={() => handleRemoveOutput(index)}
            className="text-red-500"
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
};

export default TransactionOutputsDisplay;
