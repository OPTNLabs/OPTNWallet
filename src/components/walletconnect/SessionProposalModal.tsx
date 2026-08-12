// src/components/walletconnect/SessionProposalModal.tsx
import { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { AppDispatch, RootState } from '../../redux/store';
import { approveSessionProposal, rejectSessionProposal } from '../../redux/walletconnectSlice';
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
    } catch (err) {
      console.error('Error approving session:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await dispatch(rejectSessionProposal()).unwrap();
    } catch (err) {
      console.error('Error rejecting session:', err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="wallet-popup-backdrop">
      <div className="wallet-popup-panel max-w-md w-full">
        <h2 className="text-2xl font-bold text-center mb-4">Approve Session</h2>
        <div className="flex justify-center mb-4">
          <img
            src={dappMetadata.icons[0]}
            alt="DApp icon"
            className="w-16 h-16 rounded-full"
          />
        </div>
        <div className="text-center">
          <p className="font-semibold text-lg">{dappMetadata.name}</p>
          {dappUrl ? (
            <a
              href={dappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="wallet-link underline text-sm"
            >
              {dappMetadata.url}
            </a>
          ) : (
            <span className="wallet-muted text-sm break-all">
              {dappMetadata.url}
            </span>
          )}
          <p className="wallet-muted text-sm mt-2">{dappMetadata.description}</p>
        </div>
        <div className="flex justify-around mt-6">
          <button
            onClick={handleApprove}
            className="wallet-btn-primary px-4 py-2"
            disabled={submitting}
          >
            {submitting ? 'Working...' : 'Approve'}
          </button>
          <button
            onClick={handleReject}
            className="wallet-btn-danger px-4 py-2"
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
