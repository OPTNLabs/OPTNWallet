// src/components/SessionProposalModal.tsx

import React from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { RootState, AppDispatch } from '../redux/store'
import {
  approveSessionProposal,
  rejectSessionProposal,
  clearPendingProposal,
} from '../redux/walletconnectSlice'
import { Toast } from '@capacitor/toast'

const SessionProposalModal: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>()
  const proposal = useSelector((state: RootState) => state.walletconnect.pendingProposal)

  if (!proposal) {
    return null // No proposal => no modal => no UI
  }

  const { id, params } = proposal
  const { proposer } = params
  const { metadata } = proposer

  const handleApprove = async () => {
    console.log('[SessionProposalModal] Approving session with ID:', id)
    try {
      await dispatch(approveSessionProposal()).unwrap()
      console.log('[SessionProposalModal] Approve success.')
      await Toast.show({ text: 'Session approved!' })
      dispatch(clearPendingProposal())
    } catch (err) {
      console.error('[SessionProposalModal] error approving session:', err)
      await Toast.show({ text: String(err) })
    }
  }

  const handleReject = async () => {
    console.log('[SessionProposalModal] Rejecting session with ID:', id)
    try {
      await dispatch(rejectSessionProposal()).unwrap()
      console.log('[SessionProposalModal] Reject success.')
      await Toast.show({ text: 'Session rejected.' })
      dispatch(clearPendingProposal())
    } catch (err) {
      console.error('[SessionProposalModal] error rejecting session:', err)
      await Toast.show({ text: String(err) })
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
      <div className="bg-white p-4 w-96 rounded shadow-md">
        <h3 className="text-lg font-bold mb-2">Session Proposal</h3>
        <p className="mb-4">
          <strong>DApp Name:</strong> {metadata.name}<br />
          <strong>Description:</strong> {metadata.description}<br />
          <strong>Website:</strong> {metadata.url}
        </p>
        <div className="flex justify-end space-x-2">
          <button onClick={handleApprove} className="bg-green-600 text-white px-3 py-1 rounded">
            Approve
          </button>
          <button onClick={handleReject} className="bg-red-600 text-white px-3 py-1 rounded">
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}

export default SessionProposalModal
