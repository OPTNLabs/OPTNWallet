import React from 'react';
import { UTXO } from '../../types/types';

interface SelectedUTXOsDisplayProps {
  selectedUtxos: UTXO[];
}

const SelectedUTXOsDisplay: React.FC<SelectedUTXOsDisplayProps> = ({
  selectedUtxos,
}) => {
  // **Add Logging Here**
  console.log(
    'Rendering SelectedUTXOsDisplay with selectedUtxos:',
    selectedUtxos
  );

  return (
    <div className="mb-6">
      <h3 className="text-lg font-semibold mb-2">
        Selected Transaction Inputs
      </h3>
      {selectedUtxos.map((utxo) => (
        <div
          key={utxo.id}
          className="flex flex-col items-start mb-2 w-full break-words whitespace-normal"
        >
          <span className="w-full">{`Address: ${utxo.address}`}</span>
          <span className="w-full">{`Amount: ${utxo.amount}`}</span>
          <span className="w-full">{`Tx Hash: ${utxo.tx_hash}`}</span>
          <span className="w-full">{`Position: ${utxo.tx_pos}`}</span>
          <span className="w-full">{`Height: ${utxo.height}`}</span>
          {/* **Display New Fields (Optional) */}
          {utxo.contractFunction && (
            <span className="w-full">{`Contract Function: ${utxo.contractFunction}`}</span>
          )}
          {utxo.contractFunctionInputs && (
            <span className="w-full">{`Contract Function Inputs: ${JSON.stringify(
              utxo.contractFunctionInputs
            )}`}</span>
          )}
          {!utxo.unlocker && utxo.abi && (
            <span className="text-red-500 w-full">Missing unlocker!</span>
          )}
        </div>
      ))}
    </div>
  );
};

export default SelectedUTXOsDisplay;
