// src/components/ScanWcQr.tsx

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

const ScanWcQr: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>()
  const [scanning, setScanning] = useState<boolean>(false)

  const handleScan = async () => {
    console.log('[ScanWcQr] handleScan called')
    try {
      setScanning(true)
      console.log('[ScanWcQr] Starting barcode scanner...')

      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1, // 1 = back camera
      })

      console.log('[ScanWcQr] Scan result:', result)
      if (result && result.ScanResult) {
        const scannedData = result.ScanResult.trim()
        console.log('[ScanWcQr] scannedData:', scannedData)

        if (scannedData.startsWith('wc:')) {
          console.log('[ScanWcQr] Valid WalletConnect URI, dispatching wcPair')
          dispatch(wcPair(scannedData))
        } else {
          console.warn('[ScanWcQr] Not a WalletConnect URI:', scannedData)
          await Toast.show({
            text: 'Not a valid WalletConnect URI.',
          })
        }
      } else {
        console.warn('[ScanWcQr] No ScanResult property in result')
        await Toast.show({
          text: 'No QR code detected. Please try again.',
        })
      }
    } catch (err) {
      console.error('[ScanWcQr] handleScan error:', err)
      await Toast.show({
        text: 'Failed to scan. Check permissions and try again.',
      })
    } finally {
      setScanning(false)
      console.log('[ScanWcQr] Scan finished')
    }
  }

  return (
    <div className="flex items-center">
      <button
        onClick={handleScan}
        className="bg-blue-500 text-white py-2 px-4 rounded flex items-center"
        disabled={scanning}
      >
        <FaCamera className="mr-2" />
        {scanning ? 'Scanning...' : 'Scan WC QR'}
      </button>
    </div>
  )
}

export default ScanWcQr
