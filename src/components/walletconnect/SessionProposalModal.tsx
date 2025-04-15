// src/components/walletconnect/SessionProposalModal.tsx
import { useSelector, useDispatch } from 'react-redux';
import { AppDispatch, RootState } from '../../redux/store';
import { approveSessionProposal, rejectSessionProposal } from '../../redux/walletconnectSlice';

function SessionProposalModal() {
  const dispatch = useDispatch<AppDispatch>();
  const proposal = useSelector((state: RootState) => state.walletconnect.pendingProposal);
  if (!proposal) return null; // No proposal → no modal

  const dappMetadata = proposal.params.proposer.metadata;

  const handleApprove = async () => {
    try {
      await dispatch(approveSessionProposal()).unwrap();
    } catch (err) {
      console.error('Error approving session:', err);
    }
  };

  const handleReject = async () => {
    try {
      await dispatch(rejectSessionProposal()).unwrap();
    } catch (err) {
      console.error('Error rejecting session:', err);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-50 z-50">
      <div className="bg-white rounded-lg shadow-lg max-w-md w-full p-6">
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
          <a
            href={dappMetadata.url}
            target="_blank"
            rel="noreferrer"
            className="text-blue-500 underline text-sm"
          >
            {dappMetadata.url}
          </a>
          <p className="text-gray-600 text-sm mt-2">{dappMetadata.description}</p>
        </div>
        <div className="flex justify-around mt-6">
          <button
            onClick={handleApprove}
            className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded"
          >
            Approve
          </button>
          <button
            onClick={handleReject}
            className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

export default SessionProposalModal;
