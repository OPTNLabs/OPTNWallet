// src/pages/ContractView.tsx

import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { useLocation, useNavigate } from 'react-router-dom';
import { TailSpin } from 'react-loader-spinner';
import ContractManager from '../../apis/ContractManager/ContractManager';
import type { ContractInstanceRow } from '../../apis/ContractManager/ContractManager';
import { hexString } from '../../utils/hex';
import { RootState } from '../../state/store';
import AddressSelectionPopup from '../../components/AddressSelectionPopup';
import KeyService from '../../services/KeyService';
import { shortenTxHash } from '../../utils/shortenHash';
import { PREFIX } from '../../utils/constants';
import { Toast } from '@capacitor/toast';
import Popup from '../../components/transaction/Popup';
import WalletTooltip from '../../components/ui/WalletTooltip';
import { logError, toErrorMessage } from '../../utils/errorHandling';
import { getReturnPath } from '../../utils/navigation';

import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { FaCamera } from 'react-icons/fa';
import { DataSigner } from '../../utils/dataSigner';
import ElectrumService from '../../services/ElectrumService';
import {
  createContractAndFetchInstances,
  deleteContractAndFetchInstances,
  updateContractAndRebuildInstance,
} from './services';
import { parseConstructorArgs, validateConstructorArgsComplete } from './utils';
import PageHeader from '../../components/ui/PageHeader';
import SectionCard from '../../components/ui/SectionCard';
import EmptyState from '../../components/ui/EmptyState';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../../utils/barcodeScanner';
import WalletScreen from '../../components/ui/WalletScreen';
import { useI18n } from '../../i18n/useI18n';
import { copyToClipboard } from '../../utils/clipboard';

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
    const directKeys = [
      'height',
      'blockHeight',
      'block_height',
      'tip',
      'tipHeight',
      'tip_height',
    ];
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
  const location = useLocation();
  const { t } = useI18n();
  const contractManager = useMemo(() => ContractManager(), []);
  const wallet_id = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector(
    (state: RootState) => state.network.currentNetwork
  );

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const fetchInitialBlock = async (attempt = 0) => {
      try {
        const block = await ElectrumService.getLatestBlock();
        const parsedHeight = extractBlockHeight(block);
        if (parsedHeight !== null) {
          if (!cancelled) {
            setBlockHeight(parsedHeight);
          }
          return;
        }
        if (!cancelled && attempt < 2) {
          retryTimer = setTimeout(() => {
            void fetchInitialBlock(attempt + 1);
          }, 1500);
        }
      } catch (err) {
        logError('ContractView.fetchInitialBlock', err, {
          currentNetwork,
          attempt,
        });
        if (!cancelled && attempt < 2) {
          retryTimer = setTimeout(() => {
            void fetchInitialBlock(attempt + 1);
          }, 1500);
        }
      }
    };

    const handleBlockUpdate = (header: unknown) => {
      const parsedHeight = extractBlockHeight(header);
      if (parsedHeight === null) return;
      setBlockHeight(parsedHeight);
      setError(null);
    };

    setBlockHeight(null);
    fetchInitialBlock();
    void ElectrumService.subscribeBlockHeaders(handleBlockUpdate);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      void ElectrumService.unsubscribeBlockHeaders(handleBlockUpdate);
    };
  }, [currentNetwork]);

  useEffect(() => {
    const loadAvailableContracts = async () => {
      try {
        const contracts = await contractManager.listAvailableArtifacts();
        if (!contracts || contracts.length === 0) {
          throw new Error(t('contractView.loadContractsFailed'));
        }
        setAvailableContracts(contracts);
      } catch (err) {
        logError('ContractView.loadAvailableContracts', err);
        setError(toErrorMessage(err, t('contractView.loadContractsFailed')));
      }
    };

    const loadContractInstances = async () => {
      try {
        const instances = await contractManager.fetchContractInstances();
        setContractInstances(instances);
      } catch (err) {
        logError('ContractView.loadContractInstances', err);
        setError(toErrorMessage(err, t('contractView.loadInstancesFailed')));
      }
    };

    loadAvailableContracts();
    loadContractInstances();
  }, [contractManager, t]);

  useEffect(() => {
    const loadContractDetails = async () => {
      if (selectedContractFile) {
        try {
          const artifact =
            await contractManager.loadArtifact(selectedContractFile);
          if (!artifact) {
            throw new Error(t('contractView.loadDetailsFailed'));
          }
          setConstructorArgs(
            (artifact.constructorInputs || []) as ContractArg[]
          );
          setShowConstructorArgsPopup(true);
        } catch (err) {
          logError('ContractView.loadContractDetails', err, {
            selectedContractFile,
          });
          setError(toErrorMessage(err, t('contractView.loadDetailsFailed')));
        }
      }
    };
    loadContractDetails();
  }, [selectedContractFile, contractManager, t]);

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setInputValues({ ...inputValues, [name]: value });
  };

  const handleCopyAddress = async (address: string) => {
    try {
      if (!(await copyToClipboard(address)))
        throw new Error('clipboard write failed');
      await Toast.show({ text: t('contractView.addressCopied') });
    } catch (error) {
      logError('ContractView.copyAddress', error, { address });
      await Toast.show({ text: t('contractView.copyFailed') });
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
        text: t('contractView.selectData'),
      });
      return;
    }
    try {
      const privKey = await KeyService.fetchAddressPrivateKey(address, 'spend');
      if (!privKey) {
        throw new Error(t('contractView.privateKeyUnavailable'));
      }
      const signer = new DataSigner(privKey);
      const message = signer.createMessage(data);
      const signature = signer.signMessage(message);
      const signatureHex = Buffer.from(signature).toString('hex');
      setInputValues({ ...inputValues, [argName]: signatureHex });
      await Toast.show({ text: t('contractView.signatureGenerated') });
    } catch (error) {
      logError('ContractView.generateSignature', error, { argName });
      await Toast.show({ text: t('contractView.signatureFailed') });
    }
  };

  const scanBarcode = async (argName: string) => {
    if (isScanning) return;
    setIsScanning(true);
    try {
      const result = await scanBarcodeSafely({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });
      if (result && result.ScanResult) {
        setInputValues((prev) => ({ ...prev, [argName]: result.ScanResult }));
      } else {
        await Toast.show({ text: t('contractView.noQr') });
      }
    } catch (error) {
      logError('ContractView.scanBarcode', error, { argName });
      await Toast.show({
        text: getBarcodeScannerErrorMessage(error),
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
        validation.errorMessage ?? t('contractView.fillRequired')
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
      await Toast.show({ text: t('contractView.created') });
    } catch (err) {
      logError('ContractView.createContract', err, {
        selectedContractFile,
      });
      setErrorMessage(
        t('contractView.createFailed', {
          message: toErrorMessage(err, t('contractView.unknownError')),
        })
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
      await Toast.show({ text: t('contractView.deleted') });
    } catch (err) {
      logError('ContractView.deleteContract', err, { contractId });
      setError(toErrorMessage(err, t('contractView.deleteFailedFallback')));
      await Toast.show({ text: t('contractView.deleteFailed') });
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
      await Toast.show({ text: t('contractView.updated') });
    } catch (err) {
      logError('ContractView.updateContract', err, { address });
      setError(toErrorMessage(err, t('contractView.updateFailedFallback')));
      await Toast.show({ text: t('contractView.updateFailed') });
    }
  };

  const handleErrorPopupClose = () => {
    setShowErrorPopup(false);
    setErrorMessage('');
  };

  if (error) {
    return (
      <WalletScreen maxWidthClassName="max-w-xl">
        <PageHeader title={t('contractView.title')} compact />
        <EmptyState
          message={t('contractView.errorPrefix', { message: error })}
        />
      </WalletScreen>
    );
  }

  const returnTarget = getReturnPath(location, `/home/${wallet_id}`);

  return (
    <WalletScreen maxWidthClassName="max-w-xl">
      <div className="flex min-h-full flex-col gap-4">
        <PageHeader title={t('contractView.title')} compact />
        <div className="space-y-4">
          <SectionCard title={t('contractView.create')} className="mb-4">
            <div className="space-y-3">
              <div className="wallet-surface-strong rounded-2xl p-3 text-sm wallet-muted">
                <div className="font-semibold wallet-text-strong">
                  {t('contractView.howWorks')}
                </div>
                <div className="mt-2 grid gap-2">
                  <div>{t('contractView.pickTemplate')}</div>
                  <div>{t('contractView.fillInputs')}</div>
                  <div>{t('contractView.createStep')}</div>
                </div>
              </div>
              <select
                className="wallet-input w-full"
                value={selectedContractFile}
                onChange={(e) => setSelectedContractFile(e.target.value)}
              >
                <option value="">{t('contractView.selectContract')}</option>
                {availableContracts.map((contract, index) => (
                  <option key={index} value={contract.fileName}>
                    {contract.contractName}
                  </option>
                ))}
              </select>
              {selectedContractFile && (
                <div className="text-xs wallet-muted">
                  {t('contractView.fillRequired')}
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard title={t('contractView.instantiated')} className="mb-4">
            {contractInstances.length > 0 ? (
              <div className="max-h-[28rem] overflow-y-auto pr-1">
                <ul className="space-y-3">
                  {contractInstances.map((instance) => (
                    <li key={instance.id} className="p-4 wallet-card">
                      <div className="space-y-2">
                        <div className="text-sm font-semibold wallet-text-strong">
                          {instance.contract_name}
                        </div>

                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-3 text-left text-sm"
                          onClick={() => handleCopyAddress(instance.address)}
                        >
                          <span className="wallet-muted">
                            {t('contractView.address')}
                          </span>
                          <span className="truncate font-mono wallet-text-strong">
                            {shortenTxHash(
                              instance.address,
                              PREFIX[currentNetwork].length
                            )}
                          </span>
                        </button>

                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-3 text-left text-sm"
                          onClick={() =>
                            handleCopyAddress(instance.token_address)
                          }
                        >
                          <span className="wallet-muted">
                            {t('contractView.tokenAddress')}
                          </span>
                          <span className="truncate font-mono wallet-text-strong">
                            {shortenTxHash(
                              instance.token_address,
                              PREFIX[currentNetwork].length
                            )}
                          </span>
                        </button>

                        <div className="text-sm">
                          <span className="wallet-muted">
                            {t('contractView.balance')}:
                          </span>{' '}
                          <span className="font-semibold wallet-text-strong">
                            {instance.balance.toString()}
                          </span>{' '}
                          satoshis
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          onClick={() => deleteContract(instance.id)}
                          className="wallet-btn-danger"
                        >
                          {t('contractView.delete')}
                        </button>
                        <button
                          onClick={() => updateContract(instance.address)}
                          className="wallet-btn-primary"
                        >
                          {t('contractView.update')}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <EmptyState message={t('contractView.noInstances')} />
            )}
          </SectionCard>
        </div>

        <div className="mt-auto pb-2 pt-3">
          <button
            onClick={() => navigate(returnTarget)}
            className="wallet-btn-danger w-full py-3 font-semibold"
          >
            {t('contractView.back')}
          </button>
        </div>
      </div>

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
              {t('contractView.constructorArgs')}
            </h2>
            <p className="wallet-muted text-center text-sm mt-1">
              {t('contractView.fillRequired')}
            </p>
          </div>

          <div
            className="rounded-xl border px-4 py-3 mb-4"
            style={{ borderColor: 'var(--wallet-border)' }}
          >
            <div className="flex items-center justify-center gap-1 text-sm wallet-muted">
              <span>{t('contractView.blockHeight')}</span>
              <span
                data-tooltip-id="block-height"
                className="cursor-pointer wallet-accent-icon text-base font-bold select-none"
                aria-label={t('contractView.blockHeight')}
                role="img"
              >
                ⓘ
              </span>
            </div>
            <WalletTooltip
              id="block-height"
              place="top"
              className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
              content={t('contractView.blockHeightInfo')}
            />
            <div className="text-center text-2xl font-semibold tabular-nums mt-1">
              {blockHeight ?? t('contractView.unavailable')}
            </div>
          </div>

          <div className="max-h-[52vh] overflow-y-auto pr-1 mb-4 space-y-3">
            {constructorArgs.length === 0 && (
              <div
                className="rounded-xl border p-3 text-sm wallet-muted"
                style={{ borderColor: 'var(--wallet-border)' }}
              >
                {t('contractView.noInputs')}
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
                        aria-label={t('contractView.datasigInfo')}
                        role="img"
                      >
                        ⓘ
                      </span>
                      <WalletTooltip
                        id={`datasig-tt-${index}`}
                        place="top"
                        className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
                        content={t('contractView.selectData')}
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
                      placeholder={t('contractView.enterMessage', {
                        name: arg.name,
                      })}
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
                        aria-label={`${t('contractView.selectAddress')} ${arg.name}`}
                      >
                        {t('contractView.selectAddress')}
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
                        {t('contractView.signMessage')}
                      </button>
                    </div>

                    {selectedAddresses[arg.name] && (
                      <div className="text-sm wallet-muted">
                        {t('contractView.signingAddress')}:{' '}
                        {shortenTxHash(
                          selectedAddresses[arg.name],
                          PREFIX[currentNetwork].length
                        )}
                      </div>
                    )}
                    {inputValues[arg.name] && (
                      <div className="text-sm mt-1 wallet-muted">
                        {t('contractView.signature')}:{' '}
                        {shortenTxHash(inputValues[arg.name], 0)}
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
                      aria-label={t('contractView.argumentTypeInfo')}
                      role="img"
                    >
                      ⓘ
                    </span>
                    <WalletTooltip
                      id={`argtype-tt-${index}`}
                      place="top"
                      className="max-w-[80vw] whitespace-normal break-words text-sm leading-snug"
                      content={
                        isAddressType
                          ? arg.type === 'pubkey'
                            ? t('contractView.publicKeyInfo')
                            : t('contractView.hashInfo')
                          : t('contractView.enterType', { type: arg.type })
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
                          aria-label={`${t('contractView.selectAddress')} ${arg.name}`}
                        >
                          {t('contractView.selectAddress')}
                        </button>

                        <button
                          type="button"
                          onClick={() => scanBarcode(arg.name)}
                          className={`wallet-btn-primary h-11 w-11 p-0 ${
                            isScanning ? 'opacity-50 cursor-not-allowed' : ''
                          }`}
                          disabled={isScanning}
                          aria-label={t('contractView.scanQr', {
                            name: arg.name,
                          })}
                        >
                          <FaCamera />
                        </button>
                      </div>

                      {inputValues[arg.name] && (
                        <div className="text-sm mt-2 wallet-muted break-all">
                          {t('contractView.selected', { type: arg.type })}:{' '}
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
                      placeholder={t('contractView.enterMessage', {
                        name: arg.name,
                      })}
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
                <div className="font-bold">{t('contractView.create')}</div>
              )}
            </button>
          </div>
        </Popup>
      )}

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
          <h2 className="text-lg font-semibold mb-2">
            {t('contractView.error')}
          </h2>
          <p className="mb-4">{errorMessage}</p>
        </Popup>
      )}
    </WalletScreen>
  );
};

export default ContractView;
