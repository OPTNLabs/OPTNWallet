// src/components/walletconnect/SessionProposalModal.tsx
import { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { AppDispatch, RootState } from '../../state/store';
import { approveSessionProposal, rejectSessionProposal } from '../../state/slices/walletconnectSlice';
import { enqueueNotification } from '../../state/slices/notificationsSlice';
import { normalizeExternalUrl } from '../../utils/externalUrl';

function SessionProposalModal() {
  const dispatch = useDispatch<AppDispatch>();
  const [submitting, setSubmitting] = useState(false);
  const proposal = useSelector((state: RootState) => state.walletconnect.pendingProposal);
  if (!proposal) return null; // No proposal → no modal

  const dappMetadata = proposal.params.proposer.metadata;
  const dappUrl = normalizeExternalUrl(dappMetadata.url);

  const handleApprove = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await dispatch(approveSessionProposal()).unwrap();
      dispatch(
        enqueueNotification({
          id: `walletconnect:proposal:approved:${proposal.id}`,
          kind: 'walletconnect',
          title: 'WalletConnect session approved',
          body: `Connected to ${dappMetadata.name}.`,
          createdAt: Date.now(),
        })
      );
    } catch (err) {
      console.error('Error approving session:', err);
      dispatch(
        enqueueNotification({
          id: `walletconnect:proposal:approve-error:${proposal.id}`,
          kind: 'walletconnect',
          title: 'WalletConnect approval failed',
          body: `Failed to approve the session request from ${dappMetadata.name}.`,
          createdAt: Date.now(),
        })
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await dispatch(rejectSessionProposal()).unwrap();
      dispatch(
        enqueueNotification({
          id: `walletconnect:proposal:rejected:${proposal.id}`,
          kind: 'walletconnect',
          title: 'WalletConnect session rejected',
          body: `Rejected the session request from ${dappMetadata.name}.`,
          createdAt: Date.now(),
        })
      );
    } catch (err) {
      console.error('Error rejecting session:', err);
      dispatch(
        enqueueNotification({
          id: `walletconnect:proposal:reject-error:${proposal.id}`,
          kind: 'walletconnect',
          title: 'WalletConnect rejection failed',
          body: `Failed to reject the session request from ${dappMetadata.name}.`,
          createdAt: Date.now(),
        })
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="wallet-popup-backdrop">
      <div className="wallet-popup-panel max-w-md w-full">
        <h2 className="text-xl sm:text-2xl font-bold text-center mb-4">
          Approve Session
        </h2>
        <div className="flex justify-center mb-4">
          <img
            src={dappMetadata.icons[0]}
            alt="DApp icon"
            className="h-16 w-16 rounded-full object-cover"
          />
        </div>
        <div className="text-center">
          <p className="break-words font-semibold text-base sm:text-lg">
            {dappMetadata.name}
          </p>
          {dappUrl ? (
            <a
              href={dappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block text-xs sm:text-sm wallet-link underline break-all leading-relaxed"
            >
              {dappMetadata.url}
            </a>
          ) : (
            <span className="mt-1 block text-xs sm:text-sm wallet-muted break-all leading-relaxed">
              {dappMetadata.url}
            </span>
          )}
          <p className="wallet-muted mt-2 text-xs sm:text-sm leading-relaxed break-words">
            {dappMetadata.description}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-6">
          <button
            onClick={handleApprove}
            className="wallet-btn-primary px-3 py-2 text-sm sm:text-base"
            disabled={submitting}
          >
            {submitting ? 'Working...' : 'Approve'}
          </button>
          <button
            onClick={handleReject}
            className="wallet-btn-danger px-3 py-2 text-sm sm:text-base whitespace-nowrap"
            disabled={submitting}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

export default SessionProposalModal;
