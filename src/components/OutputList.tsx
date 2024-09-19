// src/components/OutputList.tsx
import React, { useState } from 'react';
import { TransactionOutput } from '../types/types';

interface OutputListProps {
  outputs: TransactionOutput[];
  onAddOutput: (newOutput: TransactionOutput) => void;
  onRemoveOutput: (index: number) => void;
  availableTokenCategories: string[];
}

const OutputList: React.FC<OutputListProps> = ({
  outputs,
  onAddOutput,
  onRemoveOutput,
  availableTokenCategories,
}) => {
  const [recipientAddress, setRecipientAddress] = useState<string>('');
  const [transferAmount, setTransferAmount] = useState<number | string>('');
  const [tokenAmount, setTokenAmount] = useState<number | string>('');
  const [selectedTokenCategory, setSelectedTokenCategory] =
    useState<string>('');

  const handleAddOutput = () => {
    if (recipientAddress && (transferAmount || tokenAmount)) {
      const newOutput: TransactionOutput = {
        recipientAddress,
        amount: BigInt(transferAmount || 0),
      };

      if (selectedTokenCategory && tokenAmount) {
        newOutput.token = {
          amount: BigInt(tokenAmount),
          category: selectedTokenCategory,
        };
      }

      onAddOutput(newOutput); // Trigger add output
      setRecipientAddress('');
      setTransferAmount('');
      setTokenAmount('');
      setSelectedTokenCategory('');
    }
  };

  return (
    <div className="mb-6">
      <h3 className="text-lg font-semibold mb-2">Transaction Outputs</h3>
      {outputs.map((output, index) => (
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
            onClick={() => onRemoveOutput(index)}
            className="text-red-500"
          >
            Remove
          </button>
        </div>
      ))}

      <h3 className="text-lg font-semibold mb-2">Add Output</h3>
      <input
        type="text"
        value={recipientAddress}
        placeholder="Recipient Address"
        onChange={(e) => setRecipientAddress(e.target.value)}
        className="border p-2 mb-2 w-full break-words whitespace-normal"
      />
      <input
        type="number"
        value={transferAmount}
        placeholder="Regular Amount"
        onChange={(e) => setTransferAmount(e.target.value)}
        className="border p-2 mb-2 w-full break-words whitespace-normal"
      />
      <input
        type="number"
        value={tokenAmount}
        placeholder="Token Amount"
        onChange={(e) => setTokenAmount(e.target.value)}
        className="border p-2 mb-2 w-full break-words whitespace-normal"
      />
      {availableTokenCategories.length > 0 && (
        <select
          value={selectedTokenCategory}
          onChange={(e) => setSelectedTokenCategory(e.target.value)}
          className="border p-2 mb-2 w-full break-words whitespace-normal"
        >
          <option value="">Select Token Category</option>
          {availableTokenCategories.map((category, index) => (
            <option key={index} value={category}>
              {category}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={handleAddOutput}
        className="bg-blue-500 text-white py-2 px-4 rounded"
      >
        Add Output
      </button>
    </div>
  );
};

export default OutputList;
