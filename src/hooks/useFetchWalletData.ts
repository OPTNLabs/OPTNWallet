// src/hooks/useFetchWalletData.ts

import { useEffect } from 'react';
import { ContractAddressRecord, UTXO } from '../types/types';
import TransactionService from '../services/TransactionService';

const useFetchWalletData = (
  walletId: number | null,
  // selectedAddresses: string[],
  setAddresses: React.Dispatch<
    React.SetStateAction<{ address: string; tokenAddress: string }[]>
  >,
  setContractAddresses: React.Dispatch<
    React.SetStateAction<ContractAddressRecord[]>
  >,
  setUtxos: React.Dispatch<React.SetStateAction<UTXO[]>>,
  setContractUTXOs: React.Dispatch<React.SetStateAction<UTXO[]>>,
  // setSelectedAddresses: React.Dispatch<React.SetStateAction<string[]>>,
  setChangeAddress: React.Dispatch<React.SetStateAction<string>>,
  setErrorMessage: React.Dispatch<React.SetStateAction<string | null>>
) => {
  useEffect(() => {
    if (walletId === null) return;

    let isActive = true;

    const fetchData = async () => {
      try {
        const { addresses, utxos, contractAddresses } =
          await TransactionService.fetchAddressesAndUTXOs(walletId);

        if (!isActive) return;

        // console.log('Fetched Addresses:', addresses);
        // console.log('Wallet ID:', walletId);
        // console.log('Fetched Contract Addresses:', contractAddresses);
        // console.log('Fetched UTXOs:', utxos);

        setAddresses(addresses);
        setContractAddresses(contractAddresses);
        setUtxos(utxos);
        const contractAddressSet = new Set(
          contractAddresses.map((contract) => contract.address)
        );
        setContractUTXOs(
          utxos.filter((utxo) => contractAddressSet.has(utxo.address))
        );

        // Auto-select the first address if only one exists
        // if (
        //   addresses.length === 1 &&
        //   !selectedAddresses.includes(addresses[0].address)
        // ) {
        //   setSelectedAddresses([addresses[0].address]);
        //   // console.log(`Auto-selected address: ${addresses[0].address}`);
        // }

        // Set default change address
        if (addresses.length > 0) {
          setChangeAddress(addresses[0].address);
          // console.log(`Set change address to: ${addresses[0].address}`);
        }
      } catch (error) {
        if (!isActive) return;
        console.error('Error fetching addresses and UTXOs:', error);
        setErrorMessage(
          'Error fetching addresses and UTXOs: ' + (error as Error).message
        );
      }
    };

    void fetchData();

    return () => {
      isActive = false;
    };
  }, [
    walletId,
    setAddresses,
    setChangeAddress,
    setContractAddresses,
    setContractUTXOs,
    setErrorMessage,
    setUtxos,
  ]);
};

export default useFetchWalletData;
