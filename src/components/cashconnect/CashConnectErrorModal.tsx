import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '../../state/store';
import { setCashConnectError } from '../../state/slices/cashconnectSlice';
import WalletPopupSheet from '../ui/WalletPopupSheet';

export default function CashConnectErrorModal() {
  const dispatch = useDispatch<AppDispatch>();
  const message = useSelector(
    (state: RootState) => state.cashconnect.errorMessage
  );
  if (!message) return null;

  return (
    <WalletPopupSheet
      onDismiss={() => dispatch(setCashConnectError(null))}
      footer={
        <button
          type="button"
          className="wallet-btn-primary w-full px-3 py-2"
          onClick={() => dispatch(setCashConnectError(null))}
        >
          OK
        </button>
      }
    >
      <h2 className="text-xl font-bold text-center mb-3">CashConnect</h2>
      <p className="text-sm break-words">{message}</p>
    </WalletPopupSheet>
  );
}
