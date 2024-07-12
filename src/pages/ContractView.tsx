// @ts-nocheck
import React, { useState, useEffect } from 'react';
import ContractManager from '../apis/ContractManager/ContractManager';

const ContractView = () => {
  const [contractDetails, setContractDetails] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadContract = async () => {
      try {
        const contractManager = ContractManager();
        const artifact = await contractManager.loadArtifact('p2pkh');

        // Example constructor arguments, replace '<pkh_value>' with actual value
        const constructorArgs = ['<pkh_value>'];

        const contract = await contractManager.createContract(
          artifact,
          constructorArgs
        );
        setContractDetails(contract);
      } catch (err) {
        setError(err.message);
      }
    };

    loadContract();
  }, []);

  if (error) {
    return <div>Error: {error}</div>;
  }

  if (!contractDetails) {
    return <div>Loading contract details...</div>;
  }

  return (
    <div className="container mx-auto p-4">
      <h2 className="text-lg font-semibold mb-2">Contract Details</h2>
      <div className="mb-4">
        <strong>Address:</strong> {contractDetails.address}
      </div>
      <div className="mb-4">
        <strong>Token Address:</strong> {contractDetails.tokenAddress}
      </div>
      <div className="mb-4">
        <strong>Opcount:</strong> {contractDetails.opcount}
      </div>
      <div className="mb-4">
        <strong>Bytesize:</strong> {contractDetails.bytesize}
      </div>
      <div className="mb-4">
        <strong>Bytecode:</strong> {contractDetails.bytecode}
      </div>
      <div className="mb-4">
        <strong>Balance:</strong> {contractDetails.balance.toString()} satoshis
      </div>
      <div className="mb-4">
        <strong>UTXOs:</strong>
        <ul>
          {contractDetails.utxos.map((utxo, index) => (
            <li key={index}>
              {utxo.txid}:{utxo.vout} - {utxo.satoshis.toString()} satoshis
              {utxo.token && (
                <span>
                  , Token Amount: {utxo.token.amount}, Token Category:{' '}
                  {utxo.token.category}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default ContractView;
