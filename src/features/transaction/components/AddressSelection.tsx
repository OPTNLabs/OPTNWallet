// src/components/transaction/AddressSelection.tsx

import React, { useState } from 'react';
import Popup from './Popup';
import { UTXO } from '../../../types/types';
import SweepPaperWallet from '../../../components/SweepPaperWallet';
import { useI18n } from '../../../i18n/useI18n';
import MaskedValue from '../../../components/ui/MaskedValue';
// import { Network } from 'cashscript';

interface AddressSelectionProps {
  addresses: { address: string; tokenAddress: string }[];
  selectedUtxos: UTXO[];
  selectedAddresses: string[];
  contractAddresses: {
    address: string;
    tokenAddress: string;
    contractName: string;
    abi: unknown[];
  }[];
  selectedContractAddresses: string[];
  setSelectedContractAddresses: React.Dispatch<React.SetStateAction<string[]>>;
  selectedContractABIs: unknown[];
  setSelectedContractABIs: React.Dispatch<React.SetStateAction<unknown[]>>;
  setSelectedAddresses: React.Dispatch<React.SetStateAction<string[]>>;
  setPaperWalletUTXOs: React.Dispatch<React.SetStateAction<UTXO[]>>;
}
//SweepPaperWallet
const AddressSelection: React.FC<AddressSelectionProps> = ({
  addresses,
  selectedUtxos,
  selectedAddresses,
  contractAddresses,
  selectedContractAddresses,
  setSelectedContractAddresses,
  selectedContractABIs,
  setSelectedContractABIs,
  setSelectedAddresses,
  setPaperWalletUTXOs,
}) => {
  const { t } = useI18n();
  const [showWalletAddressesPopup, setShowWalletAddressesPopup] =
    useState(false); // State for wallet addresses popup
  const [showContractAddressesPopup, setShowContractAddressesPopup] =
    useState(false);

  // Toggle selection for regular wallet addresses
  const toggleAddressSelection = (address: string) => {
    if (selectedAddresses.includes(address)) {
      setSelectedAddresses(
        selectedAddresses.filter(
          (selectedAddress) => selectedAddress !== address
        )
      );
    } else {
      setSelectedAddresses([...selectedAddresses, address]);
    }
  };

  // Toggle selection for contract addresses
  const toggleContractSelection = (address: string, abi: unknown[]) => {
    const isSelected =
      selectedContractAddresses.includes(address) &&
      selectedContractABIs.some(
        (existingAbi) => JSON.stringify(existingAbi) === JSON.stringify(abi)
      );

    if (isSelected) {
      setSelectedContractAddresses(
        selectedContractAddresses.filter(
          (selectedContractAddress) => selectedContractAddress !== address
        )
      );
      setSelectedContractABIs(
        selectedContractABIs.filter(
          (existingAbi) => JSON.stringify(existingAbi) !== JSON.stringify(abi)
        )
      );
    } else {
      setSelectedContractAddresses([...selectedContractAddresses, address]);
      setSelectedContractABIs([...selectedContractABIs, abi]);
    }
  };

  const closePopups = () => {
    setShowWalletAddressesPopup(false);
    setShowContractAddressesPopup(false);
  };

  return (
    <div className="flex flex-wrap gap-2">
      <button
        className="wallet-btn-primary flex-1"
        onClick={() => setShowWalletAddressesPopup(true)}
      >
        {t('builder.walletFunds')}
      </button>

      <button
        className="wallet-btn-primary flex-1"
        onClick={() => setShowContractAddressesPopup(true)}
      >
        {t('builder.contracts')}
      </button>

      <SweepPaperWallet setPaperWalletUTXOs={setPaperWalletUTXOs} />

      {selectedAddresses.length === 0 &&
        selectedContractAddresses.length === 0 &&
        selectedUtxos.length === 0 && (
          <div className="text-sm wallet-muted">
            {t('builder.selectSource')}
          </div>
        )}

      {showWalletAddressesPopup && (
        <Popup closePopups={closePopups}>
          <h4 className="text-md font-semibold text-center mb-4">
            {t('builder.walletSources')}
          </h4>
          <div className="overflow-y-auto max-h-80">
            {addresses.length === 0 ? (
              <p>{t('builder.noWalletAddresses')}</p>
            ) : (
              addresses.map((addressObj) => {
                const isSelected = selectedAddresses.includes(
                  addressObj.address
                );

                return (
                  <div
                    key={addressObj.address}
                    onClick={() => toggleAddressSelection(addressObj.address)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      toggleAddressSelection(addressObj.address);
                    }}
                    role="button"
                    tabIndex={0}
                    className={`w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal focus:outline-none ${
                      isSelected
                        ? 'wallet-selectable-active'
                        : 'wallet-selectable-inactive'
                    }`}
                    aria-pressed={isSelected}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {t('builder.bchAddress')}:{' '}
                        <MaskedValue
                          value={addressObj.address}
                          label={t('builder.bchAddress')}
                          ariaLabel={t('builder.bchAddress')}
                          embedded
                        />
                      </span>
                      <span className="text-sm wallet-muted">
                        {t('builder.tokenAddress')}:{' '}
                        <MaskedValue
                          value={addressObj.tokenAddress}
                          label={t('builder.tokenAddress')}
                          ariaLabel={t('builder.tokenAddress')}
                          className="text-xs"
                          embedded
                        />
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Popup>
      )}

      {showContractAddressesPopup && (
        <Popup closePopups={closePopups}>
          <h4 className="text-md font-semibold text-center mb-4">
            {t('builder.contractSources')}
          </h4>
          <div className="overflow-y-auto max-h-80">
            {contractAddresses.length === 0 ? (
              <p>{t('builder.noContractAddresses')}</p>
            ) : (
              contractAddresses.map((contractObj) => {
                const isSelected =
                  selectedContractAddresses.includes(contractObj.address) &&
                  selectedContractABIs.some(
                    (existingAbi) =>
                      JSON.stringify(existingAbi) ===
                      JSON.stringify(contractObj.abi)
                  );

                return (
                  <div
                    key={contractObj.address}
                    onClick={() =>
                      toggleContractSelection(
                        contractObj.address,
                        contractObj.abi
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      toggleContractSelection(
                        contractObj.address,
                        contractObj.abi
                      );
                    }}
                    role="button"
                    tabIndex={0}
                    className={`w-full text-left p-2 mb-2 border rounded-lg break-words whitespace-normal focus:outline-none ${
                      isSelected
                        ? 'wallet-selectable-active'
                        : 'wallet-selectable-inactive'
                    }`}
                    aria-pressed={isSelected}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {contractObj.contractName}
                      </span>
                      <span className="text-sm wallet-muted">
                        {t('builder.contractAddress')}:{' '}
                        <MaskedValue
                          value={contractObj.address}
                          label={t('builder.contractAddress')}
                          ariaLabel={t('builder.contractAddress')}
                          className="text-xs"
                          embedded
                        />
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Popup>
      )}
    </div>
  );
};

export default AddressSelection;
