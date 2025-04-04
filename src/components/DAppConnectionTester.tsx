// src/components/DAppConnectionTester.tsx

import React, { useState } from 'react'
import { useDispatch } from 'react-redux'
import { AppDispatch } from '../redux/store'
import { wcPair } from '../redux/walletconnectSlice'

const DAppConnectionTester: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>()
  const [uri, setUri] = useState('')

  const handleConnect = () => {
    console.log('[DAppConnectionTester] handleConnect called with:', uri)
    if (uri.trim().startsWith('wc:')) {
      console.log('[DAppConnectionTester] Dispatching wcPair')
      dispatch(wcPair(uri.trim()))
    } else {
      console.warn('[DAppConnectionTester] Invalid WC URI:', uri)
      alert('Please provide a valid WalletConnect URI, starting with "wc:".')
    }
  }

  return (
    <div className="flex flex-col space-y-2 p-4 bg-gray-100">
      <input
        className="border p-2"
        placeholder="Enter wc: URI"
        value={uri}
        onChange={(e) => setUri(e.target.value)}
      />
      <button
        onClick={handleConnect}
        className="bg-blue-500 text-white p-2 rounded"
      >
        Connect
      </button>
    </div>
  )
}

export default DAppConnectionTester
