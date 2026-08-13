import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '../../state/store';
import { setCashConnectError } from '../../state/slices/cashconnectSlice';

export default function CashConnectErrorModal() {
  const dispatch = useDispatch<AppDispatch>();
  const message = useSelector(
    (state: RootState) => state.cashconnect.errorMessage
  );
  if (!message) return null;

  return (
    <div className="wallet-popup-backdrop">
      <div className="wallet-popup-panel max-w-md w-full">
        <h2 className="text-xl font-bold text-center mb-4">CashConnect</h2>
        <p className="text-sm break-words">{message}</p>
        <button
          type="button"
          className="wallet-btn-primary w-full mt-6 px-3 py-2"
          onClick={() => dispatch(setCashConnectError(null))}
        >
          OK
        </button>
      </div>
    </div>
  );
}
