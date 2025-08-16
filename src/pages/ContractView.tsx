// src/pages/ContractView.tsx

import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { TailSpin } from 'react-loader-spinner';
import ContractManager from '../apis/ContractManager/ContractManager';
import { hexString } from '../utils/hex';
import { RootState } from '../redux/store';
import parseInputValue from '../utils/parseInputValue';
import AddressSelectionPopup from '../components/AddressSelectionPopup';
import KeyService from '../services/KeyService';
import { shortenTxHash } from '../utils/shortenHash';
import { PREFIX } from '../utils/constants';
import { Toast } from '@capacitor/toast';
import Popup from '../components/transaction/Popup';
import { Tooltip } from 'react-tooltip';

// Import Barcode Scanner
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { FaCamera } from 'react-icons/fa';
import { DataSigner } from '../utils/dataSigner';
import ElectrumService from '../services/ElectrumService';

interface BlockHeader {
  height: number;
  hex: string;
}

const ContractView = () => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [availableContracts, setAvailableContracts] = useState<any[]>([]);
  const [selectedContractFile, setSelectedContractFile] = useState<string>('');
  const [constructorArgs, setConstructorArgs] = useState<any[]>([]);
  const [inputValues, setInputValues] = useState<{ [key: string]: any }>({});
  const [contractInstances, setContractInstances] = useState<any[]>([]);
  const [showAddressPopup, setShowAddressPopup] = useState<boolean>(false);
  const [currentArgName, setCurrentArgName] = useState<string>('');
  const [showConstructorArgsPopup, setShowConstructorArgsPopup] =
    useState<boolean>(false);
  const [showErrorPopup, setShowErrorPopup] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [blockHeader, setBlockHeader] = useState<BlockHeader | null>(null);
  // datasig helpers
  const [selectedAddresses, setSelectedAddresses] = useState<{
    [key: string]: string;
  }>({});
  const [dataToSign, setDataToSign] = useState<{ [key: string]: string }>({});

  const navigate = useNavigate();
  const wallet_id = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector(
    (state: RootState) => state.network.currentNetwork
  );

  useEffect(() => {
    // Initial fetch of latest block
    const fetchInitialBlock = async () => {
      try {
        const block = await ElectrumService.getLatestBlock();
        if (block) {
          setBlockHeader(block as BlockHeader);
        }
      } catch (err) {
        console.error('Failed to fetch initial block header', err);
      }
    };

    // Subscribe to block header updates
    const handleBlockUpdate = (header: BlockHeader) => {
      setBlockHeader(header);
      setError(null);
    };

    fetchInitialBlock();
    ElectrumService.subscribeBlockHeaders(handleBlockUpdate);

    // Cleanup subscription on component unmount
    return () => {
      // Note: You might need to implement an unsubscribe method in your ElectrumServer
    };
  }, []);

  useEffect(() => {
    const loadAvailableContracts = async () => {
      try {
        const contractManager = ContractManager();
        const contracts = contractManager.listAvailableArtifacts();
        if (!contracts || contracts.length === 0) {
          throw new Error('No available contracts found');
        }
        setAvailableContracts(contracts);
      } catch (err: any) {
        console.error('Error loading available contracts:', err);
        setError(err.message);
      }
    };

    const loadContractInstances = async () => {
      try {
        const contractManager = ContractManager();
        const instances = await contractManager.fetchContractInstances();
        setContractInstances(instances);
      } catch (err: any) {
        console.error('Error loading contract instances:', err);
        setError(err.message);
      }
    };

    loadAvailableContracts();
    loadContractInstances();
  }, []);

  useEffect(() => {
    const loadContractDetails = async () => {
      if (selectedContractFile) {
        try {
          const contractManager = ContractManager();
          const artifact = contractManager.loadArtifact(selectedContractFile);
          if (!artifact)
            throw new Error(
              `Artifact ${selectedContractFile} could not be loaded`
            );
          setConstructorArgs(artifact.constructorInputs || []);
          setShowConstructorArgsPopup(true);
        } catch (err: any) {
          console.error('Error loading contract details:', err);
          setError(err.message);
        }
      }
    };
    loadContractDetails();
  }, [selectedContractFile]);

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setInputValues({ ...inputValues, [name]: value });
  };

  const handleCopyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      await Toast.show({ text: 'Address copied to clipboard!' });
    } catch (error) {
      console.error('Failed to copy address:', error);
      await Toast.show({ text: 'Failed to copy address.' });
    }
  };

  const handleAddressSelect = async (address: string) => {
    const keys = await KeyService.retrieveKeys(wallet_id);
    const selectedKey = keys.find((key) => key.address === address);

    if (selectedKey) {
      const matchedArg = constructorArgs.find(
        (arg) => arg.name === currentArgName
      );
      if (matchedArg) {
        let valueToSet = '';
        if (matchedArg.type === 'pubkey')
          valueToSet = hexString(selectedKey.publicKey);
        else if (matchedArg.type === 'bytes20')
          valueToSet = hexString(selectedKey.pubkeyHash);
        else if (matchedArg.type === 'datasig') {
          setSelectedAddresses({
            ...selectedAddresses,
            [currentArgName]: address,
          });
        }
        setInputValues({ ...inputValues, [currentArgName]: valueToSet });
      }
    }
    setShowAddressPopup(false);
    setCurrentArgName('');
  };

  const generateSignature = async (argName: string) => {
    const address = selectedAddresses[argName];
    const data = dataToSign[argName];
    if (!address || !data) {
      await Toast.show({
        text: 'Please select an address and enter data to sign.',
      });
      return;
    }
    try {
      const privKey = await KeyService.fetchAddressPrivateKey(address);
      const signer = new DataSigner(privKey);
      const message = signer.createMessage(data);
      const signature = signer.signMessage(message);
      const signatureHex = Buffer.from(signature).toString('hex');
      setInputValues({ ...inputValues, [argName]: signatureHex });
      await Toast.show({ text: 'Signature generated successfully!' });
    } catch (error) {
      console.error('Error generating signature:', error);
      await Toast.show({ text: 'Failed to generate signature.' });
    }
  };

  const scanBarcode = async (argName: string) => {
    if (isScanning) return;
    setIsScanning(true);
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });
      if (result && result.ScanResult) {
        setInputValues((prev) => ({ ...prev, [argName]: result.ScanResult }));
      } else {
        await Toast.show({ text: 'No QR code detected. Please try again.' });
      }
    } catch (error) {
      console.error('Barcode scan error:', error);
      await Toast.show({
        text: 'Failed to scan QR code. Please ensure camera permissions are granted and try again.',
      });
    } finally {
      setIsScanning(false);
    }
  };

  const validateConstructorArgs = (): boolean => {
    for (const arg of constructorArgs) {
      if (
        inputValues[arg.name] === undefined ||
        inputValues[arg.name] === null ||
        inputValues[arg.name].toString().trim() === ''
      ) {
        setErrorMessage(
          `Please provide a value for "${arg.name}" (${arg.type}).`
        );
        setShowErrorPopup(true);
        return false;
      }
    }
    return true;
  };

  const createContract = async () => {
    if (!validateConstructorArgs()) return;
    setIsLoading(true);
    try {
      const contractManager = ContractManager();
      const args =
        constructorArgs.map((arg) =>
          parseInputValue(inputValues[arg.name], arg.type)
        ) || [];
      if (
        constructorArgs.length > 0 &&
        args.length !== constructorArgs.length
      ) {
        throw new Error('All constructor arguments must be provided');
      }
      await contractManager.createContract(
        selectedContractFile,
        args,
        currentNetwork
      );
      const instances = await contractManager.fetchContractInstances();
      setContractInstances(instances);
      setSelectedContractFile('');
      setConstructorArgs([]);
      setInputValues({});
      setSelectedAddresses({});
      setDataToSign({});
      setShowConstructorArgsPopup(false);
      await Toast.show({ text: 'Contract created successfully!' });
    } catch (err: any) {
      console.error('Error creating contract:', err);
      setErrorMessage(`Failed to create contract: ${err.message}`);
      setShowErrorPopup(true);
    } finally {
      setIsLoading(false);
    }
  };

  const deleteContract = async (contractId: string) => {
    try {
      const contractManager = ContractManager();
      await contractManager.deleteContractInstance(parseInt(contractId));
      const instances = await contractManager.fetchContractInstances();
      setContractInstances(instances);
      await Toast.show({ text: 'Contract deleted successfully!' });
    } catch (err: any) {
      console.error('Error deleting contract:', err);
      setError(err.message);
      await Toast.show({ text: 'Failed to delete contract.' });
    }
  };

  const updateContract = async (address: string) => {
    try {
      const contractManager = ContractManager();
      await contractManager.updateContractUTXOs(address);
      const updatedContractInstance =
        await contractManager.getContractInstanceByAddress(address);
      const totalBalance = updatedContractInstance.utxos.reduce(
        (sum: bigint, utxo: any) => sum + BigInt(utxo.amount),
        BigInt(0)
      );
      setContractInstances((prev) =>
        prev.map((inst) =>
          inst.address === address
            ? {
                ...inst,
                balance: totalBalance,
                utxos: updatedContractInstance.utxos,
              }
            : inst
        )
      );
      await Toast.show({ text: 'Contract updated successfully!' });
    } catch (err: any) {
      console.error('Error updating UTXOs and balance:', err);
      setError(err.message);
      await Toast.show({ text: 'Failed to update contract.' });
    }
  };

  const handleErrorPopupClose = () => {
    setShowErrorPopup(false);
    setErrorMessage('');
  };

  if (error) return <div>Error: {error}</div>;

  const returnHome = () => navigate(`/home/${wallet_id}`);

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="max-w-full h-auto"
        />
      </div>

      {/* Select Contract + tooltip */}
      <h2 className="text-lg font-semibold flex items-center justify-center gap-2 mb-2">
        <span>Select Contract</span>
      </h2>

      <select
        className="border p-2 mb-4 w-full"
        value={selectedContractFile}
        onChange={(e) => setSelectedContractFile(e.target.value)}
      >
        <option value="">Select a contract</option>
        {availableContracts.map((contract, index) => (
          <option key={index} value={contract.fileName}>
            {contract.contractName}
          </option>
        ))}
      </select>

      {/* Constructor Args Popup */}
      {showConstructorArgsPopup && (
        <Popup
          closePopups={() => {
            setShowConstructorArgsPopup(false);
            setSelectedContractFile('');
            setConstructorArgs([]);
            setInputValues({});
            setCurrentArgName('');
          }}
        >
          {/* Popup title + tooltip */}
          <h2 className="text-lg font-semibold flex items-center justify-center gap-2 mb-2">
            <span>Constructor Arguments</span>
          </h2>

          <div className="max-h-96 overflow-y-auto mb-4">
            <p className="flex flex-col items-center">
              <div className="flex items-center">
                <span>Current Block Height</span>
                <span
                  data-tooltip-id="block-height"
                  className="cursor-pointer text-yellow-600 text-base font-bold select-none"
                  aria-label="Data signature info"
                  role="img"
                >
                  ⓘ
                </span>
              </div>
              <Tooltip
                id="block-height"
                place="top"
                className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
                content="Blocks increment on an average interval of 10 minutes."
              />
              <span className="font-bold">{blockHeader.height}</span>
            </p>

            {constructorArgs.map((arg, index) => {
              if (arg.type === 'datasig') {
                return (
                  <div key={index} className="mb-4">
                    <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                      <span>{arg.name} (datasig)</span>
                      <span
                        data-tooltip-id={`datasig-tt-${index}`}
                        className="cursor-pointer text-yellow-600 text-base font-bold select-none"
                        aria-label="Data signature info"
                        role="img"
                      >
                        ⓘ
                      </span>
                      <Tooltip
                        id={`datasig-tt-${index}`}
                        place="top"
                        className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
                        content="Sign arbitrary data with a selected wallet address. The resulting signature (hex) is passed to the constructor."
                      />
                    </label>

                    <input
                      type="text"
                      name={`${arg.name}_data`}
                      value={dataToSign[arg.name] || ''}
                      onChange={(e) =>
                        setDataToSign({
                          ...dataToSign,
                          [arg.name]: e.target.value,
                        })
                      }
                      className="border p-2 w-full rounded-md mb-2"
                      placeholder={`Enter data to sign for ${arg.name}`}
                    />

                    <div className="flex items-center mb-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setCurrentArgName(arg.name);
                          setShowAddressPopup(true);
                        }}
                        className={`bg-blue-500 hover:bg-blue-600 transition duration-300 font-bold text-white py-2 px-4 rounded ${
                          isScanning ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                        disabled={isScanning}
                        aria-label={`Select Address for ${arg.name}`}
                        data-tooltip-id={`select-addr-tt-${index}`}
                      >
                        Select Address
                      </button>
                      <button
                        type="button"
                        onClick={() => generateSignature(arg.name)}
                        className={`bg-green-500 hover:bg-green-600 transition duration-300 font-bold text-white py-2 px-4 rounded ${
                          !selectedAddresses[arg.name] || !dataToSign[arg.name]
                            ? 'opacity-50 cursor-not-allowed'
                            : ''
                        }`}
                        disabled={
                          !selectedAddresses[arg.name] || !dataToSign[arg.name]
                        }
                        data-tooltip-id={`sign-msg-tt-${index}`}
                      >
                        Sign Message
                      </button>
                      <Tooltip
                        id={`sign-msg-tt-${index}`}
                        place="top"
                        className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
                        content="Create a signature using the selected address' private key over the provided data."
                      />
                    </div>

                    {selectedAddresses[arg.name] && (
                      <div className="text-sm mt-2">
                        {shortenTxHash(
                          selectedAddresses[arg.name],
                          PREFIX[currentNetwork].length
                        )}
                      </div>
                    )}
                    {inputValues[arg.name] && (
                      <div className="mt-2">
                        Signature: {shortenTxHash(inputValues[arg.name], 0)}
                      </div>
                    )}
                  </div>
                );
              } else {
                const isAddressType =
                  arg.type === 'bytes20' || arg.type === 'pubkey';
                return (
                  <div key={index} className="mb-4">
                    <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                      <span>
                        {arg.name} ({arg.type})
                      </span>
                      <span
                        data-tooltip-id={`argtype-tt-${index}`}
                        className="cursor-pointer text-yellow-600 text-base font-bold select-none"
                        aria-label="Argument type info"
                        role="img"
                      >
                        ⓘ
                      </span>
                      <Tooltip
                        id={`argtype-tt-${index}`}
                        place="top"
                        className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
                        content={
                          isAddressType
                            ? arg.type === 'pubkey'
                              ? 'Public key in hex. Use “Select Address” to fill automatically.'
                              : '20-byte hash (hex) of an address/public key. Use “Select Address”.'
                            : `Enter a value matching type: ${arg.type}.`
                        }
                      />
                    </label>

                    {isAddressType ? (
                      <>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setCurrentArgName(arg.name);
                              setShowAddressPopup(true);
                            }}
                            className={`bg-blue-500 hover:bg-blue-600 transition duration-300 font-bold text-white py-2 px-4 rounded ${
                              isScanning ? 'opacity-50 cursor-not-allowed' : ''
                            }`}
                            disabled={isScanning}
                            aria-label={`Select Address for ${arg.name}`}
                            data-tooltip-id={`select-addr2-tt-${index}`}
                          >
                            Select Address
                          </button>
                          <Tooltip
                            id={`select-addr2-tt-${index}`}
                            place="top"
                            className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
                            content="Pick an address from your wallet to auto-fill this argument."
                          />

                          <button
                            type="button"
                            onClick={() => scanBarcode(arg.name)}
                            className={`bg-green-500 hover:bg-green-600 transition duration-300 text-white py-2 px-4 rounded ${
                              isScanning ? 'opacity-50 cursor-not-allowed' : ''
                            }`}
                            disabled={isScanning}
                            aria-label={`Scan QR Code for ${arg.name}`}
                            data-tooltip-id={`scan-qr-tt-${index}`}
                          >
                            <FaCamera />
                          </button>
                          <Tooltip
                            id={`scan-qr-tt-${index}`}
                            place="top"
                            className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
                            content="Scan a QR code to populate this field."
                          />
                        </div>

                        {inputValues[arg.name] && (
                          <div className="mt-2">
                            Selected {arg.type}:{' '}
                            {shortenTxHash(inputValues[arg.name])}
                          </div>
                        )}
                      </>
                    ) : (
                      <input
                        type="text"
                        name={arg.name}
                        value={inputValues[arg.name] || ''}
                        onChange={handleInputChange}
                        className="border p-2 w-full rounded-md"
                        placeholder={`Enter ${arg.name}`}
                      />
                    )}
                  </div>
                );
              }
            })}
          </div>

          <div className="flex flex-col items-end">
            <button
              onClick={createContract}
              className={`bg-green-500 hover:bg-green-600 transition duration-300 text-white py-2 px-4 rounded mb-4 flex items-center justify-center ${
                isLoading ? 'cursor-not-allowed opacity-50' : ''
              }`}
              disabled={isLoading}
              data-tooltip-id="create-contract-tt"
            >
              {isLoading ? (
                <TailSpin
                  visible={true}
                  height="24"
                  width="24"
                  color="white"
                  ariaLabel="tail-spin-loading"
                  radius="1"
                />
              ) : (
                <div className="font-bold">Create Contract</div>
              )}
            </button>
            <Tooltip
              id="create-contract-tt"
              place="top"
              className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
              content="Instantiate the selected contract using the values provided above."
            />
          </div>
        </Popup>
      )}

      {contractInstances.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold flex items-center justify-center gap-2 mb-2">
            <span>Instantiated Contracts</span>
          </h2>

          <div className="overflow-y-auto max-h-80 mb-4">
            <ul>
              {contractInstances.map((instance) => (
                <li
                  key={instance.id}
                  className="mb-4 p-4 border rounded bg-gray-100"
                >
                  <div>
                    <div className="mb-2 overflow-x-auto">
                      <strong>Contract Name:</strong> {instance.contract_name}
                    </div>

                    <div
                      className="mb-2 cursor-pointer flex items-center text-sm gap-2"
                      onClick={() => handleCopyAddress(instance.address)}
                    >
                      <strong>Address:</strong>{' '}
                      {shortenTxHash(
                        instance.address,
                        PREFIX[currentNetwork].length
                      )}
                    </div>

                    <div
                      className="mb-2 cursor-pointer flex items-center text-sm gap-2"
                      onClick={() => handleCopyAddress(instance.token_address)}
                    >
                      <strong>Token Address:</strong>{' '}
                      {shortenTxHash(
                        instance.token_address,
                        PREFIX[currentNetwork].length
                      )}
                    </div>

                    <div className="mb-2 text-sm">
                      <strong>Balance:</strong> {instance.balance.toString()}{' '}
                      satoshis
                    </div>
                  </div>

                  <div className="grid grid-cols-[auto,auto] justify-between">
                    <button
                      onClick={() => deleteContract(instance.id)}
                      className="bg-red-500 hover:bg-red-600 font-bold text-white py-2 px-4 my-2 rounded"
                      data-tooltip-id={`delete-tt-${instance.id}`}
                    >
                      Delete
                    </button>
                    <Tooltip
                      id={`delete-tt-${instance.id}`}
                      place="top"
                      className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
                      content="Remove this contract instance from your local list."
                    />

                    <button
                      onClick={() => updateContract(instance.address)}
                      className="bg-green-500 hover:bg-green-600 font-bold text-white py-2 px-4 my-2 rounded justify-self-end"
                      data-tooltip-id={`update-tt-${instance.id}`}
                    >
                      Update
                    </button>
                    <Tooltip
                      id={`update-tt-${instance.id}`}
                      place="top"
                      className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
                      content="Refresh UTXOs and balance for this contract address."
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <button
        onClick={returnHome}
        className="w-full bg-red-500 font-bold text-white py-2 px-4 rounded-md hover:bg-red-600 transition duration-300 my-2"
      >
        Go Back
      </button>

      {/* Address Selection Popup */}
      {showAddressPopup && (
        <AddressSelectionPopup
          onSelect={handleAddressSelect}
          onClose={() => {
            setShowAddressPopup(false);
            setCurrentArgName('');
          }}
        />
      )}

      {/* Error Popup */}
      {showErrorPopup && (
        <Popup closePopups={handleErrorPopupClose}>
          <h2 className="text-lg font-semibold mb-2">Error</h2>
          <p className="mb-4">{errorMessage}</p>
          <button
            onClick={handleErrorPopupClose}
            className="mt-4 bg-red-500 font-bold text-white py-2 px-4 rounded"
          >
            Close
          </button>
        </Popup>
      )}
    </div>
  );
};

export default ContractView;
