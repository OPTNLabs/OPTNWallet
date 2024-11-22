// src/components/transaction/OutputSelection.tsx

import React from 'react';

function OutputSelection({
  recipientAddress,
  setRecipientAddress,
  transferAmount,
  setTransferAmount,
  tokenAmount,
  setTokenAmount,
  utxos,
  selectedTokenCategory,
  setSelectedTokenCategory,
  addOutput,
  changeAddress,
  setChangeAddress,
}) {
  const availableTokenCategories = [
    ...new Set(
      utxos
        .filter((utxo) => utxo.token_data)
        .map((utxo) => utxo.token_data!.category)
    ),
  ];

  const handleTransferAmountChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const value = e.target.value;
    setTransferAmount(value === '' ? 0 : Number(value));
  };

  const handleTokenAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setTokenAmount(value === '' ? 0 : Number(value));
  };

  return (
    <>
      <div className="mb-6">
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
          onChange={handleTransferAmountChange}
          className="border p-2 mb-2 w-full break-words whitespace-normal"
        />
        <input
          type="number"
          value={tokenAmount}
          placeholder="Token Amount"
          onChange={handleTokenAmountChange}
          className="border p-2 mb-2 w-full break-words whitespace-normal"
        />
        {availableTokenCategories.length > 0 && (
          <select
            value={selectedTokenCategory}
            onChange={(e) => setSelectedTokenCategory(e.target.value)}
            className="border p-2 mb-2 w-full break-words whitespace-normal"
          >
            <option value="">Select Token Category</option>
            {availableTokenCategories.map((category: string, index) => (
              <option key={index} value={category}>
                {category}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={addOutput}
          className="bg-blue-500 text-white py-2 px-4 rounded"
        >
          Add Output
        </button>
      </div>
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-2">Change Address</h3>
        <input
          type="text"
          value={changeAddress}
          placeholder="Change Address"
          onChange={(e) => setChangeAddress(e.target.value)}
          className="border p-2 mb-2 w-full break-words whitespace-normal"
        />
      </div>
    </>
  );
}

export default OutputSelection;
