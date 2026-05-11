import { useEffect } from 'react';
import { resetContract } from '../../state/slices/contractSlice';
import { clearTransaction } from '../../state/slices/transactionBuilderSlice';
import { AppDispatch } from '../../state/store';
import { PaperWalletSecretStore } from '../../services/PaperWalletSecretStore';

export function useTransactionInit(dispatch: AppDispatch) {
  useEffect(() => {
    dispatch(clearTransaction());
    dispatch(resetContract());
    PaperWalletSecretStore.clear();
  }, [dispatch]);
}
