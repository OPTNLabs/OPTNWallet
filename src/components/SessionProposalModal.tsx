// src/components/walletconnect/SessionProposalModal.tsx
import React from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { AppDispatch, RootState } from '../redux/store'
import { approveSessionProposal, rejectSessionProposal } from '../redux/walletconnectSlice'

const SessionProposalModal: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>()
  const pendingProposal = useSelector((state: RootState) => state.walletconnect.pendingProposal)

  if (!pendingProposal) {
    return null // no proposal => hide the modal
  }

  const dappMeta = pendingProposal.params.proposer.metadata
  // maybe chain info from pendingProposal.params.requiredNamespaces['bch'].chains

  const handleApprove = async () => {
    try {
      await dispatch(approveSessionProposal()).unwrap()
    } catch (err) {
      console.error('Error approving WC session:', err)
    }
  }

  const handleReject = async () => {
    try {
      await dispatch(rejectSessionProposal()).unwrap()
    } catch (err) {
      console.error('Error rejecting WC session:', err)
    }
  }

  return (
    <div className="fixed top-0 left-0 w-screen h-screen flex items-center justify-center">
      <div className="bg-white p-6 border border-gray-300 rounded">
        <h2>WC Session Proposal</h2>
        <img src={dappMeta.icons[0]} alt="dAppIcon" style={{ width:50 }} />
        <p>{dappMeta.name}</p>
        <a href={dappMeta.url} target="_blank" rel="noreferrer">{dappMeta.url}</a>
        <p>{dappMeta.description}</p>

        {/* Approve / Reject Buttons */}
        <button onClick={handleApprove} className="bg-green-500 text-white px-4 py-2">Approve</button>
        <button onClick={handleReject} className="bg-red-500 text-white px-4 py-2">Reject</button>
      </div>
    </div>
  )
}

export default SessionProposalModal
