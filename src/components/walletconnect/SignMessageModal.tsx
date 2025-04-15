// src/components/walletconnect/SignMessageModal.tsx
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../redux/store';
import {
  respondWithMessageSignature,
  respondWithMessageError,
  clearPendingSignMsg,
} from '../../redux/walletconnectSlice';

export function SignMessageModal() {
  const dispatch = useDispatch<AppDispatch>();
  const signMsgRequest = useSelector((state: RootState) => state.walletconnect.pendingSignMsg);
  if (!signMsgRequest) return null;

  const requestParams = signMsgRequest.params.request.params;
  const message = Array.isArray(requestParams)
    ? requestParams[0]
    : requestParams?.message || '';

  const handleSign = async () => {
    await dispatch(respondWithMessageSignature(signMsgRequest));
    dispatch(clearPendingSignMsg());
  };

  const handleCancel = async () => {
    await dispatch(respondWithMessageError(signMsgRequest));
    dispatch(clearPendingSignMsg());
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-70 z-50">
      <div className="bg-white rounded-lg shadow-lg max-w-sm w-full p-6">
        <h3 className="text-xl font-bold mb-4 text-center">Sign Message</h3>
        <p className="text-gray-800 mb-4">
          Message: <span className="font-mono">{message}</span>
        </p>
        <div className="flex justify-around">
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
