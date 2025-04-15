// src/components/walletconnect/SignTransactionModal.tsx
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../redux/store';
import { respondWithTxSignature, clearPendingSignTx, respondWithTxError } from '../../redux/walletconnectSlice';

export function SignTransactionModal() {
  const dispatch = useDispatch<AppDispatch>();
  const signTxRequest = useSelector((state: RootState) => state.walletconnect.pendingSignTx);
  if (!signTxRequest) return null;

  const handleSign = async () => {
    await dispatch(respondWithTxSignature(signTxRequest));
    dispatch(clearPendingSignTx());
  };

  const handleCancel = async () => {
    await dispatch(respondWithTxError(signTxRequest));
    dispatch(clearPendingSignTx());
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-70 z-50">
      <div className="bg-white rounded-lg shadow-lg max-w-sm w-full p-6">
        <h3 className="text-xl font-bold mb-4 text-center">Sign Transaction</h3>
        {/* You can add a summary of the transaction details here if needed */}
        <div className="flex justify-around mt-4">
          <button
            onClick={handleSign}
            className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded"
          >
            Sign
          </button>
          <button
            onClick={handleCancel}
            className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
