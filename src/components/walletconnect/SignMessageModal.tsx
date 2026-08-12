import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../redux/store';
import {
  respondWithMessageSignature,
  respondWithMessageError,
  clearPendingSignMsg,
} from '../../redux/walletconnectSlice';

export function SignMessageModal() {
  const dispatch = useDispatch<AppDispatch>();
  const signMsgRequest = useSelector(
    (state: RootState) => state.walletconnect.pendingSignMsg
  );
  const activeSessions = useSelector(
    (state: RootState) => state.walletconnect.activeSessions
  );

  if (!signMsgRequest) return null;

  const { topic, params } = signMsgRequest;
  const { request } = params;

  const message = Array.isArray(request.params)
    ? request.params[0]
    : request?.params?.message || '';

  const dappMetadata = activeSessions?.[topic]?.peer?.metadata;

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
      <div className="bg-white rounded-lg shadow-lg max-w-md w-full p-6 space-y-4">
        <h3 className="text-xl font-bold text-center">Sign Message Request</h3>

        {dappMetadata && (
          <div className="text-sm text-gray-600">
            <div>
              <strong>DApp Name:</strong> {dappMetadata.name}
            </div>
            <div>
              <strong>Domain:</strong>{' '}
              <a
                href={dappMetadata.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 underline"
              >
                {dappMetadata.url}
              </a>
            </div>
          </div>
        )}

        <div className="bg-gray-100 rounded p-3 font-mono text-sm max-h-40 overflow-auto">
          <strong>Message to Sign:</strong>
          <pre className="whitespace-pre-wrap break-words">{message}</pre>
        </div>

        <div className="bg-gray-50 rounded p-2 text-xs text-gray-500 max-h-24 overflow-auto">
          <strong>Raw Request:</strong>
          <pre>{JSON.stringify(request, null, 2)}</pre>
        </div>

        <div className="flex justify-around pt-2">
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
