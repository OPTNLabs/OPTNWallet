import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../state/store';
import {
  respondWithMessageSignature,
  respondWithMessageError,
  clearPendingSignMsg,
} from '../../state/slices/walletconnectSlice';
import { enqueueNotification } from '../../state/slices/notificationsSlice';
import { normalizeExternalUrl } from '../../utils/externalUrl';

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
  const dappUrl = dappMetadata?.url ? normalizeExternalUrl(dappMetadata.url) : null;

  const handleSign = async () => {
    try {
      await dispatch(respondWithMessageSignature(signMsgRequest)).unwrap();
      dispatch(
        enqueueNotification({
          id: `walletconnect:msg:signed:${topic}:${signMsgRequest.id}`,
          kind: 'walletconnect',
          title: 'WalletConnect message signed',
          body: dappMetadata?.name
            ? `Approved request from ${dappMetadata.name}.`
            : 'Approved the WalletConnect message request.',
          createdAt: Date.now(),
        })
      );
      dispatch(clearPendingSignMsg());
    } catch (error) {
      console.error('[WalletConnect] Failed to sign message request', error);
      dispatch(
        enqueueNotification({
          id: `walletconnect:msg:sign-error:${topic}:${signMsgRequest.id}`,
          kind: 'walletconnect',
          title: 'WalletConnect message failed',
          body: 'Failed to sign WalletConnect message request.',
          createdAt: Date.now(),
        })
      );
    }
  };

  const handleCancel = async () => {
    try {
      await dispatch(respondWithMessageError(signMsgRequest)).unwrap();
      dispatch(
        enqueueNotification({
          id: `walletconnect:msg:rejected:${topic}:${signMsgRequest.id}`,
          kind: 'walletconnect',
          title: 'WalletConnect message rejected',
          body: 'Rejected the WalletConnect message request.',
          createdAt: Date.now(),
        })
      );
      dispatch(clearPendingSignMsg());
    } catch (error) {
      console.error('[WalletConnect] Failed to reject message request', error);
      dispatch(
        enqueueNotification({
          id: `walletconnect:msg:reject-error:${topic}:${signMsgRequest.id}`,
          kind: 'walletconnect',
          title: 'WalletConnect rejection failed',
          body: 'Failed to reject WalletConnect message request.',
          createdAt: Date.now(),
        })
      );
    }
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
              {dappUrl ? (
                <a
                  href={dappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="wallet-link underline"
                >
                  {dappMetadata.url}
                </a>
              ) : (
                <span className="wallet-muted break-all">{dappMetadata.url}</span>
              )}
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
