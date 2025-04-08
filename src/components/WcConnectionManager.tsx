// src/components/WcConnectionManager.tsx

import React, { useState } from 'react'
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner'
import { Toast } from '@capacitor/toast'
import { useDispatch } from 'react-redux'
import { AppDispatch } from '../redux/store'
import { wcPair } from '../redux/walletconnectSlice'
import { FaCamera } from 'react-icons/fa'

const WcConnectionManager: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>()
  const [scanning, setScanning] = useState<boolean>(false)
  const [uri, setUri] = useState('')

  const handleManualConnect = async () => {
    console.log('[WcConnectionManager] handleManualConnect called with:', uri)
    if (!uri.trim().startsWith('wc:')) {
      console.warn('[WcConnectionManager] Invalid WC URI:', uri)
      await Toast.show({ text: 'Please provide a valid WalletConnect URI' })
      return
    }
    try {
      console.log('[WcConnectionManager] Dispatching wcPair')
      await dispatch(wcPair(uri.trim())).unwrap()
      console.log('[WcConnectionManager] Manual connect successful')
      await Toast.show({ text: 'WalletConnect pairing successful!' })
    } catch (err) {
      console.error('[WcConnectionManager] Error pairing manually:', err)
      await Toast.show({ text: `Error: ${String(err)}` })
    }
  }

  const handleScan = async () => {
    console.log('[WcConnectionManager] handleScan called')
    try {
      setScanning(true)
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      })
      console.log('[WcConnectionManager] Scan result:', result)
      if (result && result.ScanResult) {
        const scannedData = result.ScanResult.trim()
        if (scannedData.startsWith('wc:')) {
          console.log('[WcConnectionManager] dispatching wcPair for scannedData')
          await dispatch(wcPair(scannedData)).unwrap()
          console.log('[WcConnectionManager] QR connect successful')
          await Toast.show({ text: 'WalletConnect pairing successful via QR!' })
        } else {
          console.warn('[WcConnectionManager] Not a valid wc: URI:', scannedData)
          await Toast.show({ text: 'Not a valid WalletConnect URI' })
        }
      } else {
        await Toast.show({ text: 'No QR code detected. Try again.' })
      }
    } catch (err) {
      console.error('[WcConnectionManager] Scan error:', err)
      await Toast.show({ text: `Scan error: ${String(err)}` })
    } finally {
      setScanning(false)
      console.log('[WcConnectionManager] Scan finished')
    }
  }

  return (
    <div className="space-y-4 p-4 bg-gray-100">
      <div className="flex flex-col space-y-2">
        <label className="font-bold">Enter WalletConnect URI:</label>
        <input
          className="border p-2"
          placeholder="wc:..."
          value={uri}
          onChange={(e) => setUri(e.target.value)}
        />
        <button onClick={handleManualConnect} className="bg-blue-500 text-white p-2 rounded">
          Connect
        </button>
      </div>

      <div className="flex items-center space-x-2">
        <button
          onClick={handleScan}
          className="bg-green-500 text-white py-2 px-4 rounded flex items-center"
          disabled={scanning}
        >
          <FaCamera className="mr-2" />
          {scanning ? 'Scanning...' : 'Scan WC QR'}
        </button>
      </div>
    </div>
  )
}

export default WcConnectionManager
