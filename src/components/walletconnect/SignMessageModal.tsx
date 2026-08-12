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
    <div className="wallet-popup-backdrop">
      <div className="wallet-popup-panel max-w-md w-full space-y-4">
        <h3 className="text-xl font-bold text-center">Sign Message Request</h3>

        {dappMetadata && (
          <div className="text-sm wallet-muted">
            <div>
              <strong>DApp Name:</strong> {dappMetadata.name}
            </div>
            <div>
              <strong>Domain:</strong>{' '}
              <a
                href={dappMetadata.url}
                target="_blank"
                rel="noopener noreferrer"
                className="wallet-link underline"
              >
                {dappMetadata.url}
              </a>
            </div>
          </div>
        )}

        <div className="wallet-surface-strong rounded p-3 font-mono text-sm max-h-40 overflow-auto">
          <strong>Message to Sign:</strong>
          <pre className="whitespace-pre-wrap break-words">{message}</pre>
        </div>

        <div className="flex justify-around pt-2">
          <button
            onClick={handleSign}
            className="wallet-btn-primary"
          >
            Sign
          </button>
          <button
            onClick={handleCancel}
            className="wallet-btn-danger"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
