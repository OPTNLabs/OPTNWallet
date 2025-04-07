// src/components/SessionProposalModal.tsx

import React from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { RootState, AppDispatch } from '../redux/store'
import {
  approveSessionProposal,
  rejectSessionProposal,
  clearPendingProposal,
} from '../redux/walletconnectSlice'

const SessionProposalModal: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>()
  const pendingProposal = useSelector((state: RootState) => state.walletconnect.pendingProposal)

  if (!pendingProposal) {
    return null // no proposal, no modal
  }

  const { proposer } = pendingProposal.params
  const { metadata } = proposer

  const handleApprove = async () => {
    try {
      await dispatch(approveSessionProposal()).unwrap()
      // clear out the proposal from the store
      dispatch(clearPendingProposal())
    } catch (err) {
      console.error('[SessionProposalModal] Error approving session:', err)
    }
  }

  const handleReject = async () => {
    try {
      await dispatch(rejectSessionProposal()).unwrap()
      dispatch(clearPendingProposal())
    } catch (err) {
      console.error('[SessionProposalModal] Error rejecting session:', err)
    }
  }

  return (
    <div className="fixed top-0 left-0 w-full h-full bg-black bg-opacity-50 flex justify-center items-center z-50">
      <div className="bg-white p-4 w-96 rounded shadow-lg space-y-4">
        <h2 className="text-lg font-bold">Approve Session?</h2>
        <div className="flex items-center">
          {metadata.icons[0] && (
            <img
              src={metadata.icons[0]}
              alt="DApp icon"
              className="w-10 h-10 mr-4"
            />
          )}
          <div>
            <p className="font-semibold">{metadata.name}</p>
            <p className="text-blue-600">{metadata.url}</p>
            <p className="text-sm text-gray-700">{metadata.description}</p>
          </div>
        </div>
        <div className="space-x-2 mt-4 flex justify-end">
          <button
            onClick={handleApprove}
            className="bg-green-600 text-white py-1 px-3 rounded"
          >
            Approve
          </button>
          <button
            onClick={handleReject}
            className="bg-red-600 text-white py-1 px-3 rounded"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}

export default SessionProposalModal
