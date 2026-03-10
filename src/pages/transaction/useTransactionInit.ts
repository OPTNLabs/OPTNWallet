import { useEffect } from 'react';
import { resetContract } from '../../redux/contractSlice';
import { clearTransaction } from '../../redux/transactionBuilderSlice';
import { AppDispatch } from '../../redux/store';
import { PaperWalletSecretStore } from '../../services/PaperWalletSecretStore';

export function useTransactionInit(dispatch: AppDispatch) {
  useEffect(() => {
    dispatch(clearTransaction());
    dispatch(resetContract());
    PaperWalletSecretStore.clear();
  }, [dispatch]);
}
