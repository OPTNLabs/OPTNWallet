import { useEffect } from 'react';
import TransactionService from '../services/TransactionService';

const useFetchWalletAddresses = (
  walletId: number | null,
  setAddresses: React.Dispatch<
    React.SetStateAction<{ address: string; tokenAddress: string }[]>
  >,
  setChangeAddress: React.Dispatch<React.SetStateAction<string>>,
  setErrorMessage: React.Dispatch<React.SetStateAction<string | null>>
) => {
  useEffect(() => {
    if (walletId === null) return;

    let isActive = true;

    const fetchData = async () => {
      try {
        const { addresses, defaultChangeAddress } =
          await TransactionService.fetchWalletAddresses(walletId);

        if (!isActive) return;

        setAddresses(addresses);
        if (addresses.length > 0) {
          setChangeAddress(defaultChangeAddress);
        }
      } catch (error) {
        if (!isActive) return;
        console.error('Error fetching wallet addresses:', error);
        setErrorMessage(
          'Error fetching wallet addresses: ' + (error as Error).message
        );
      }
    };

    void fetchData();

    return () => {
      isActive = false;
    };
  }, [walletId, setAddresses, setChangeAddress, setErrorMessage]);
};

export default useFetchWalletAddresses;
