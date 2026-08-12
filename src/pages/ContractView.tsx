// src/pages/ContractView.tsx

import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { TailSpin } from 'react-loader-spinner';
import ContractManager from '../apis/ContractManager/ContractManager';
import type { ContractInstanceRow } from '../apis/ContractManager/ContractManager';
import { hexString } from '../utils/hex';
import { RootState } from '../redux/store';
import AddressSelectionPopup from '../components/AddressSelectionPopup';
import KeyService from '../services/KeyService';
import { shortenTxHash } from '../utils/shortenHash';
import { PREFIX } from '../utils/constants';
import { Toast } from '@capacitor/toast';
import Popup from '../components/transaction/Popup';
import { Tooltip } from 'react-tooltip';
import { logError, toErrorMessage } from '../utils/errorHandling';

import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { FaCamera } from 'react-icons/fa';
import { DataSigner } from '../utils/dataSigner';
import ElectrumService from '../services/ElectrumService';
import {
  createContractAndFetchInstances,
  deleteContractAndFetchInstances,
  updateContractAndRebuildInstance,
} from './contract-view/services';
import {
  parseConstructorArgs,
  validateConstructorArgsComplete,
} from './contract-view/utils';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import EmptyState from '../components/ui/EmptyState';

interface ContractArg {
  name: string;
  type: string;
}

interface AvailableContract {
  fileName: string;
  contractName: string;
}

const extractBlockHeight = (header: unknown): number | null => {
  if (typeof header === 'number' && Number.isFinite(header)) {
    return Math.trunc(header);
  }
  if (typeof header === 'string') {
    const parsed = Number(header);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  if (Array.isArray(header)) {
    for (const item of header) {
      const nestedHeight = extractBlockHeight(item);
      if (nestedHeight !== null) return nestedHeight;
    }
    return null;
  }
  if (header && typeof header === 'object') {
    const possibleHeight = header as Record<string, unknown>;
    const directKeys = ['height', 'blockHeight', 'block_height', 'tip'];
    for (const key of directKeys) {
      const value = possibleHeight[key];
      const parsed = extractBlockHeight(value);
      if (parsed !== null) return parsed;
    }
  }
  return null;
};

const ContractView = () => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [availableContracts, setAvailableContracts] = useState<
    AvailableContract[]
  >([]);
  const [selectedContractFile, setSelectedContractFile] = useState<string>('');
  const [constructorArgs, setConstructorArgs] = useState<ContractArg[]>([]);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [contractInstances, setContractInstances] = useState<
    ContractInstanceRow[]
  >([]);
  const [showAddressPopup, setShowAddressPopup] = useState<boolean>(false);
  const [currentArgName, setCurrentArgName] = useState<string>('');
  const [showConstructorArgsPopup, setShowConstructorArgsPopup] =
    useState<boolean>(false);
  const [showErrorPopup, setShowErrorPopup] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [blockHeight, setBlockHeight] = useState<number | null>(null);

  // datasig helpers
  const [selectedAddresses, setSelectedAddresses] = useState<{
    [key: string]: string;
  }>({});
  const [dataToSign, setDataToSign] = useState<{ [key: string]: string }>({});

  const navigate = useNavigate();
  const contractManager = useMemo(() => ContractManager(), []);
  const wallet_id = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector(
    (state: RootState) => state.network.currentNetwork
  );

  useEffect(() => {
    const fetchInitialBlock = async () => {
      try {
        const block = await ElectrumService.getLatestBlock();
        setBlockHeight(extractBlockHeight(block));
      } catch (err) {
        logError('ContractView.fetchInitialBlock', err);
      }
    };

    const handleBlockUpdate = (header: unknown) => {
      setBlockHeight(extractBlockHeight(header));
      setError(null);
    };

    fetchInitialBlock();
    ElectrumService.subscribeBlockHeaders(handleBlockUpdate);

    return () => {
      void ElectrumService.unsubscribeBlockHeaders();
    };
  }, []);

  useEffect(() => {
    const loadAvailableContracts = async () => {
      try {
        const contracts = await contractManager.listAvailableArtifacts();
        if (!contracts || contracts.length === 0) {
          throw new Error('No available contracts found');
        }
        setAvailableContracts(contracts);
      } catch (err) {
        logError('ContractView.loadAvailableContracts', err);
        setError(toErrorMessage(err, 'Failed to load available contracts.'));
      }
    };

    const loadContractInstances = async () => {
      try {
        const instances = await contractManager.fetchContractInstances();
        setContractInstances(instances);
      } catch (err) {
        logError('ContractView.loadContractInstances', err);
        setError(toErrorMessage(err, 'Failed to load contract instances.'));
      }
    };

    loadAvailableContracts();
    loadContractInstances();
  }, [contractManager]);

  useEffect(() => {
    const loadContractDetails = async () => {
      if (selectedContractFile) {
        try {
          const artifact =
            await contractManager.loadArtifact(selectedContractFile);
          if (!artifact) {
            throw new Error(
              `Artifact ${selectedContractFile} could not be loaded`
            );
          }
          setConstructorArgs(
            (artifact.constructorInputs || []) as ContractArg[]
          );
          setShowConstructorArgsPopup(true);
        } catch (err) {
          logError('ContractView.loadContractDetails', err, {
            selectedContractFile,
          });
          setError(toErrorMessage(err, 'Failed to load contract details.'));
        }
      }
    };
    loadContractDetails();
  }, [selectedContractFile, contractManager]);

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setInputValues({ ...inputValues, [name]: value });
  };

  const handleCopyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      await Toast.show({ text: 'Address copied to clipboard!' });
    } catch (error) {
      logError('ContractView.copyAddress', error, { address });
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
      logError('ContractView.generateSignature', error, { argName });
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
      logError('ContractView.scanBarcode', error, { argName });
      await Toast.show({
        text: 'Failed to scan QR code. Please ensure camera permissions are granted and try again.',
      });
    } finally {
      setIsScanning(false);
    }
  };

  const validateConstructorArgs = (): boolean => {
    const validation = validateConstructorArgsComplete(
      constructorArgs,
      inputValues
    );
    if (!validation.valid) {
      setErrorMessage(
        validation.errorMessage ?? 'Missing constructor arguments.'
      );
      setShowErrorPopup(true);
      return false;
    }
    return validation.valid;
  };

  const createContract = async () => {
    if (!validateConstructorArgs()) return;
    setIsLoading(true);
    try {
      const args = parseConstructorArgs(constructorArgs, inputValues) || [];
      const instances = await createContractAndFetchInstances({
        contractManager,
        selectedContractFile,
        args,
        constructorArgs,
        currentNetwork,
      });
      setContractInstances(instances as ContractInstanceRow[]);
      setSelectedContractFile('');
      setConstructorArgs([]);
      setInputValues({});
      setSelectedAddresses({});
      setDataToSign({});
      setShowConstructorArgsPopup(false);
      await Toast.show({ text: 'Contract created successfully!' });
    } catch (err) {
      logError('ContractView.createContract', err, {
        selectedContractFile,
      });
      setErrorMessage(
        `Failed to create contract: ${toErrorMessage(err, 'Unknown error')}`
      );
      setShowErrorPopup(true);
    } finally {
      setIsLoading(false);
    }
  };

  const deleteContract = async (contractId: number | string) => {
    try {
      const instances = await deleteContractAndFetchInstances({
        contractManager,
        contractId: Number(contractId),
      });
      setContractInstances(instances as ContractInstanceRow[]);
      await Toast.show({ text: 'Contract deleted successfully!' });
    } catch (err) {
      logError('ContractView.deleteContract', err, { contractId });
      setError(toErrorMessage(err, 'Failed to delete contract.'));
      await Toast.show({ text: 'Failed to delete contract.' });
    }
  };

  const updateContract = async (address: string) => {
    try {
      const { updatedContractInstance, totalBalance } =
        await updateContractAndRebuildInstance({
          contractManager,
          address,
        });
      setContractInstances((prev) =>
        prev.map((inst) =>
          inst.address === address
            ? {
                ...inst,
                balance: totalBalance,
                utxos:
                  updatedContractInstance.utxos as ContractInstanceRow['utxos'],
              }
            : inst
        )
      );
      await Toast.show({ text: 'Contract updated successfully!' });
    } catch (err) {
      logError('ContractView.updateContract', err, { address });
      setError(toErrorMessage(err, 'Failed to update contract.'));
      await Toast.show({ text: 'Failed to update contract.' });
    }
  };

  const handleErrorPopupClose = () => {
    setShowErrorPopup(false);
    setErrorMessage('');
  };

  if (error) {
    return (
      <div className="container mx-auto max-w-md p-4 pb-16 wallet-page">
        <PageHeader title="Contracts" compact />
        <EmptyState message={`Error: ${error}`} />
      </div>
    );
  }

  const returnHome = () => navigate(`/home/${wallet_id}`);

  return (
    <div className="container mx-auto max-w-xl p-4 pb-16 wallet-page">
      <PageHeader
        title="Contracts"
        subtitle="Instantiate and manage contracts"
        compact
      />

      <SectionCard title="Contract Templates" className="mb-4">
        <select
          className="wallet-input mb-4 w-full"
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
      </SectionCard>

      {showConstructorArgsPopup && (
        <Popup
          closePopups={() => {
            setShowConstructorArgsPopup(false);
            setShowAddressPopup(false);
            setSelectedContractFile('');
            setConstructorArgs([]);
            setInputValues({});
            setCurrentArgName('');
          }}
        >
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-center">
              Constructor Arguments
            </h2>
            <p className="wallet-muted text-center text-sm mt-1">
              Fill in each required value before creating the contract.
            </p>
          </div>

          <div
            className="rounded-xl border px-4 py-3 mb-4"
            style={{ borderColor: 'var(--wallet-border)' }}
          >
            <div className="flex items-center justify-center gap-1 text-sm wallet-muted">
              <span>Current Block Height</span>
              <span
                data-tooltip-id="block-height"
                className="cursor-pointer wallet-accent-icon text-base font-bold select-none"
                aria-label="Block height info"
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
            <div className="text-center text-2xl font-semibold tabular-nums mt-1">
              {blockHeight ?? 'Unavailable'}
            </div>
          </div>

          <div className="pr-1 mb-4 space-y-3">
            {constructorArgs.length === 0 && (
              <div
                className="rounded-xl border p-3 text-sm wallet-muted"
                style={{ borderColor: 'var(--wallet-border)' }}
              >
                This contract template has no constructor inputs.
              </div>
            )}

            {constructorArgs.map((arg, index) => {
              if (arg.type === 'datasig') {
                return (
                  <div
                    key={index}
                    className="rounded-xl border p-3"
                    style={{ borderColor: 'var(--wallet-border)' }}
                  >
                    <label className="text-sm font-medium wallet-muted flex items-center gap-2 mb-2">
                      <span>{arg.name} (datasig)</span>
                      <span
                        data-tooltip-id={`datasig-tt-${index}`}
                        className="cursor-pointer wallet-accent-icon text-base font-bold select-none"
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
                      className="wallet-input w-full mb-2"
                      placeholder={`Enter message for ${arg.name}`}
                    />

                    <div className="flex items-center mb-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setCurrentArgName(arg.name);
                          setShowAddressPopup(true);
                        }}
                        className={`wallet-btn-primary ${
                          isScanning ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                        disabled={isScanning}
                        aria-label={`Select Address for ${arg.name}`}
                      >
                        Select Address
                      </button>

                      <button
                        type="button"
                        onClick={() => generateSignature(arg.name)}
                        className={`wallet-btn-primary ${
                          !selectedAddresses[arg.name] || !dataToSign[arg.name]
                            ? 'opacity-50 cursor-not-allowed'
                            : ''
                        }`}
                        disabled={
                          !selectedAddresses[arg.name] || !dataToSign[arg.name]
                        }
                      >
                        Sign Message
                      </button>
                    </div>

                    {selectedAddresses[arg.name] && (
                      <div className="text-sm wallet-muted">
                        Signing address:{' '}
                        {shortenTxHash(
                          selectedAddresses[arg.name],
                          PREFIX[currentNetwork].length
                        )}
                      </div>
                    )}
                    {inputValues[arg.name] && (
                      <div className="text-sm mt-1 wallet-muted">
                        Signature: {shortenTxHash(inputValues[arg.name], 0)}
                      </div>
                    )}
                  </div>
                );
              }

              const isAddressType =
                arg.type === 'bytes20' || arg.type === 'pubkey';
              return (
                <div
                  key={index}
                  className="rounded-xl border p-3"
                  style={{ borderColor: 'var(--wallet-border)' }}
                >
                  <label className="text-sm font-medium wallet-muted flex items-center gap-2 mb-2">
                    <span>
                      {arg.name} ({arg.type})
                    </span>
                    <span
                      data-tooltip-id={`argtype-tt-${index}`}
                      className="cursor-pointer wallet-accent-icon text-base font-bold select-none"
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
                          className={`wallet-btn-primary flex-1 ${
                            isScanning ? 'opacity-50 cursor-not-allowed' : ''
                          }`}
                          disabled={isScanning}
                          aria-label={`Select Address for ${arg.name}`}
                        >
                          Select Address
                        </button>

                        <button
                          type="button"
                          onClick={() => scanBarcode(arg.name)}
                          className={`wallet-btn-primary h-11 w-11 p-0 ${
                            isScanning ? 'opacity-50 cursor-not-allowed' : ''
                          }`}
                          disabled={isScanning}
                          aria-label={`Scan QR Code for ${arg.name}`}
                        >
                          <FaCamera />
                        </button>
                      </div>

                      {inputValues[arg.name] && (
                        <div className="text-sm mt-2 wallet-muted break-all">
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
                      className="wallet-input w-full"
                      placeholder={`Enter ${arg.name}`}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div
            className="sticky bottom-0 pt-2 pb-1 flex justify-end"
            style={{
              background:
                'linear-gradient(to top, var(--wallet-card-bg) 72%, transparent)',
            }}
          >
            <button
              onClick={createContract}
              className={`wallet-btn-primary w-full sm:w-auto sm:min-w-[190px] mb-4 flex items-center justify-center ${
                isLoading ? 'cursor-not-allowed opacity-50' : ''
              }`}
              disabled={isLoading}
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
          </div>
        </Popup>
      )}

      {contractInstances.length > 0 && (
        <SectionCard title="Instantiated Contracts">
          <div className="overflow-y-auto max-h-80 mb-4">
            <ul>
              {contractInstances.map((instance) => (
                <li key={instance.id} className="mb-4 p-4 wallet-card">
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
                      className="wallet-btn-danger my-2"
                    >
                      Delete
                    </button>

                    <button
                      onClick={() => updateContract(instance.address)}
                      className="wallet-btn-primary my-2 justify-self-end"
                    >
                      Update
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </SectionCard>
      )}

      <button onClick={returnHome} className="wallet-btn-danger w-full my-2">
        Go Back
      </button>

      {showAddressPopup && (
        <AddressSelectionPopup
          onSelect={handleAddressSelect}
          onClose={() => {
            setShowAddressPopup(false);
            setCurrentArgName('');
          }}
        />
      )}

      {showErrorPopup && (
        <Popup closePopups={handleErrorPopupClose}>
          <h2 className="text-lg font-semibold mb-2">Error</h2>
          <p className="mb-4">{errorMessage}</p>
        </Popup>
      )}
    </div>
  );
};

export default ContractView;
