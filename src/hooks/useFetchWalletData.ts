// src/hooks/useFetchWalletData.ts

import {
  useEffect,
  // useState
} from 'react';
import { UTXO } from '../types/types';
// import { useDispatch } from 'react-redux';
import TransactionService from '../services/TransactionService';
// import { clearTransaction, setTxOutputs } from '../redux/transactionBuilderSlice';

// interface WalletData {
//   addresses: { address: string; tokenAddress: string }[];
//   utxos: UTXO[];
//   contractAddresses: {
//     address: string;
//     tokenAddress: string;
//     contractName: string;
//     abi: any[];
//   }[];
// }

const useFetchWalletData = (
  walletId: number | null,
  selectedAddresses: string[],
  setAddresses: React.Dispatch<
    React.SetStateAction<{ address: string; tokenAddress: string }[]>
  >,
  setContractAddresses: React.Dispatch<
    React.SetStateAction<
      {
        address: string;
        tokenAddress: string;
        contractName: string;
        abi: any[];
      }[]
    >
  >,
  setUtxos: React.Dispatch<React.SetStateAction<UTXO[]>>,
  setContractUTXOs: React.Dispatch<React.SetStateAction<UTXO[]>>,
  setSelectedAddresses: React.Dispatch<React.SetStateAction<string[]>>,
  setChangeAddress: React.Dispatch<React.SetStateAction<string>>,
  setErrorMessage: React.Dispatch<React.SetStateAction<string | null>>
) => {
  // const dispatch = useDispatch();

  useEffect(() => {
    const fetchData = async (walletId: number) => {
      try {
        const { addresses, utxos, contractAddresses } =
          await TransactionService.fetchAddressesAndUTXOs(walletId);
        setAddresses(addresses);
        setContractAddresses(contractAddresses);
        setUtxos(utxos);
        setContractUTXOs(
          contractAddresses.flatMap((contract) =>
            utxos.filter((utxo) => utxo.address === contract.address)
          )
        );

        // Auto-select the first address if only one exists
        if (
          addresses.length === 1 &&
          !selectedAddresses.includes(addresses[0].address)
        ) {
          setSelectedAddresses([addresses[0].address]);
        }

        // Set default change address
        if (addresses.length > 0) {
          setChangeAddress(addresses[0].address);
        }
      } catch (error) {
        console.error('Error fetching addresses and UTXOs:', error);
        setErrorMessage(
          'Error fetching addresses and UTXOs: ' + (error as Error).message
        );
      }
    };

    if (walletId !== null) {
      fetchData(walletId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId]);
};

export default useFetchWalletData;
