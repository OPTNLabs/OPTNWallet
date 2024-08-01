// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import ContractManager from '../apis/ContractManager/ContractManager';
import ContractList from '../components/ContractList';
import InteractWithContractPopup from '../components/InteractWithContractPopup';
import KeyManager from '../apis/WalletManager/KeyManager';
import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
  Contract,
} from 'cashscript';

const hexString = (pkh) => {
  return Array.from(pkh, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const ContractTransactionPage: React.FC = () => {
  const [contracts, setContracts] = useState<any[]>([]);
  const [selectedContract, setSelectedContract] = useState<any>(null);
  const [showPopup, setShowPopup] = useState(false);
  const [walletId, setWalletId] = useState<number>(1); // Assume wallet ID is 1 for this example

  const contractFunction = useSelector(
    (state: RootState) => state.contract.selectedFunction
  );
  const contractFunctionInputs = useSelector(
    (state: RootState) => state.contract.inputs
  );
  const contractFunctionInputValues = useSelector(
    (state: RootState) => state.contract.inputValues
  );

  useEffect(() => {
    const fetchContracts = async () => {
      const contractManager = ContractManager();
      const contractInstances = await contractManager.fetchContractInstances();
      setContracts(contractInstances);
    };
    fetchContracts();
  }, []);

  const handleSelectContract = (contract: any) => {
    console.log('select', contract);
    setSelectedContract(contract);
    setShowPopup(true);
  };

  const handleContractFunctionSelect = async (
    contractFunction: string,
    inputs: any[]
  ) => {
    console.log('contract function', contractFunction);
    setShowPopup(false);

    const currentNetwork = useSelector(
      (state: RootState) => state.network.currentNetwork
    );

    if (selectedContract) {
      const keyManager = KeyManager();
      const keys = await keyManager.retrieveKeys(walletId);
      const userKey = keys[0];

      if (userKey) {
        const provider = new ElectrumNetworkProvider(currentNetwork);
        console.log(userKey);

        const contractManager = ContractManager();
        const contractInstance =
          await contractManager.getContractInstanceByAddress(
            selectedContract.address
          );
        console.log(contractInstance);

        const manualContract = new Contract(
          contractInstance.artifact,
          [hexString(userKey.pubkeyHash)],
          {
            provider: provider,
            addressType: 'p2sh32',
          }
        );

        if (contractInstance) {
          console.log('contractInstance', contractInstance);
          console.log('ManualInstance', manualContract);
          const contractUtxos = contractInstance.utxos;
          const manualContractUtxos = await manualContract.getUtxos();
          const manualContractBalance = await manualContract.getBalance();
          console.log('contract UTXO', contractUtxos);
          console.log('Manual Contract UTXO', manualContractUtxos);

          const unlockableContractUtxos = manualContractUtxos.map(
            (utxo: any) => ({
              ...utxo,
              unlocker: manualContract.unlock[contractFunction](
                userKey.publicKey,
                new SignatureTemplate(userKey.privateKey)
              ),
            })
          );

          console.log(unlockableContractUtxos);

          const transactionBuilder = new TransactionBuilder({ provider });

          transactionBuilder.addInputs(unlockableContractUtxos).addOutputs([
            {
              to: contractInstance.address,
              amount: manualContractBalance / 2n - 432n,
            }, // example amount
            {
              to: contractInstance.address,
              amount: manualContractBalance / 2n,
            }, // example amount
          ]); // Example output

          console.log(transactionBuilder.build().length / 2);

          // const sendTx = await transactionBuilder.send();
          // console.log(`Transaction detail: `, sendTx.txid);
        } else {
          console.error('Contract instance not found');
        }
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
