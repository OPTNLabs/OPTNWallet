import React, { useState, useEffect } from 'react';
import ContractManager from '../apis/ContractManager/ContractManager';
import ContractList from '../components/ContractList';
import InteractWithContractPopup from '../components/InteractWithContractPopup';
import KeyManager from '../apis/WalletManager/KeyManager';
import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
  Network,
  Contract,
} from 'cashscript';

const ContractTransactionPage: React.FC = () => {
  const [contracts, setContracts] = useState<any[]>([]);
  const [selectedContract, setSelectedContract] = useState<any>(null);
  const [showPopup, setShowPopup] = useState(false);
  const [contractFunction, setContractFunction] = useState<string | null>(null);
  const [contractFunctionInputs, setContractFunctionInputs] = useState<
    any[] | null
  >(null);
  const [walletId, setWalletId] = useState<number>(1); // Assume wallet ID is 1 for this example

  useEffect(() => {
    const fetchContracts = async () => {
      const contractManager = ContractManager();
      const contractInstances = await contractManager.fetchContractInstances();
      setContracts(contractInstances);
    };
    fetchContracts();
  }, []);

  const handleSelectContract = (contract: any) => {
    console.log(contract);
    setSelectedContract(contract);
    setShowPopup(true);
  };

  const handleContractFunctionSelect = async (
    contractFunction: string
    // inputs: any[]
  ) => {
    setContractFunction(contractFunction);
    // setContractFunctionInputs(inputs);
    setShowPopup(false);

    if (selectedContract) {
      const keyManager = KeyManager();
      const keys = await keyManager.retrieveKeys(walletId);
      const userKey = keys[0];

      if (userKey) {
        const provider = new ElectrumNetworkProvider(Network.CHIPNET);
        console.log(provider);

        const contract = new Contract(
          selectedContract.artifact,
          [userKey.pubkeyHash],
          {
            provider,
            addressType: 'p2sh32',
          }
        );
        console.log(contract);
        const contractUtxos = await contract.getUtxos();

        const unlockableContractUtxos = contractUtxos.map((utxo: any) => ({
          ...utxo,
          unlocker: contract.unlock[contractFunction](
            userKey.publicKey,
            new SignatureTemplate(userKey.privateKey)
          ),
        }));

        const transactionBuilder = new TransactionBuilder({ provider });

        transactionBuilder.addInputs(unlockableContractUtxos).addOutputs([
          { to: contract.address, amount: 1000000n }, // example amount
          { to: userKey.address, amount: 947000n }, // example amount
        ]); // Example output

        console.log(transactionBuilder.build());

        const sendTx = await transactionBuilder.send();
        console.log(`Transaction detail: `, sendTx.txid);
      }
    }
  };

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Contract Transactions</h1>
      <ContractList
        contracts={contracts}
        onSelectContract={handleSelectContract}
      />
      {showPopup && selectedContract && (
        <InteractWithContractPopup
          contract={selectedContract}
          onClose={() => setShowPopup(false)}
          onFunctionSelect={handleContractFunctionSelect}
        />
      )}
      {contractFunction && (
        <div className="mt-6">
          <h3 className="text-lg font-semibold mb-2">
            Selected Function: {contractFunction}
          </h3>
          <ul>
            {contractFunctionInputs &&
              contractFunctionInputs.map((input, index) => (
                <li key={index}>
                  {input.name} ({input.type})
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default ContractTransactionPage;
