// src/redux/walletconnectSlice.ts
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit'
import { Core } from '@walletconnect/core'
import { WalletKit, type WalletKitTypes, type IWalletKit } from '@reown/walletkit'
import type { SessionTypes } from '@walletconnect/types'
import type { Wallet, TestNetWallet } from 'mainnet-js'
import { getSdkError } from '@walletconnect/utils'
import type { RootState } from './store'

// --- LIBAUTH & BCH SIGNING IMPORTS (optional placeholders) ---
import {
  // Example – only if you want advanced transaction signing:
  generateTransaction,
  encodeTransaction,
  sha256,
  hash256,
  hexToBin,
  binToHex,
  AuthenticationProgramState,
  TransactionGenerationError,
  // etc.
} from '@bitauth/libauth'

// If you have custom types for transaction signing:
type TransactionRequestWC = WalletKitTypes.SessionRequest
// or define more strongly as needed.

type WalletconnectState = {
  web3wallet: IWalletKit | null
  activeSessions: Record<string, SessionTypes.Struct> | null

  // We'll store a reference to the user’s BCH wallet + address
  bchWallet: Wallet | TestNetWallet | null
  walletAddress: string | null
}

const initialState: WalletconnectState = {
  web3wallet: null,
  activeSessions: null,
  bchWallet: null,
  walletAddress: null,
}

// ──────────────────────────────────────────────────────────────────────────
//  THUNK: Initialize WalletConnect
// ──────────────────────────────────────────────────────────────────────────
export const initWalletConnect = createAsyncThunk(
  'walletconnect/init',
  async (_, { dispatch }) => {
    console.log('[WalletconnectSlice] initWalletConnect triggered')

    const core = new Core({
      projectId: '<PROJECT_ID>', // Replace with your actual WC project ID
    })
    console.log('[WalletconnectSlice] Created Core instance')

    const metadata = {
      name: 'OPTN Wallet',
      description: 'OPTN WalletConnect Integration',
      url: 'https://optn.cash',
      icons: ['https://optn.cash/logo.png'],
    }

    const web3wallet = await WalletKit.init({ core, metadata })
    console.log('[WalletconnectSlice] WalletKit initialized:', web3wallet)

    const activeSessions = web3wallet.getActiveSessions()
    console.log('[WalletconnectSlice] activeSessions at init:', activeSessions)

    // Listen for incoming session requests (e.g. dApp requests)
    web3wallet.on('session_request', (event) => {
      console.log('[WalletconnectSlice] session_request event:', event)
      dispatch(handleWcRequest(event))
    })

    return { web3wallet, activeSessions }
  }
)

// ──────────────────────────────────────────────────────────────────────────
//  THUNK: Pair (connect) from scanned or typed URI (wc:...)
// ──────────────────────────────────────────────────────────────────────────
export const wcPair = createAsyncThunk(
  'walletconnect/pair',
  async (uri: string, { getState }) => {
    console.log('[WalletconnectSlice] wcPair triggered with URI:', uri)

    const state = getState() as RootState
    const walletKit = state.walletconnect.web3wallet
    if (!walletKit) {
      console.error('[WalletconnectSlice] Cannot pair - no walletKit!')
      throw new Error('WalletConnect is not initialized')
    }

    console.log('[WalletconnectSlice] Pairing now...')
    await walletKit.pair({ uri })
    console.log('[WalletconnectSlice] Pairing attempt completed')
  }
)

// ──────────────────────────────────────────────────────────────────────────
//  ACTION: Set the bchWallet & derived address
// ──────────────────────────────────────────────────────────────────────────
/** 
 * If you want to store the user’s mainnet-js wallet and its address in Redux,
 * you can dispatch this from your app whenever you have a new or loaded wallet.
 */
export const setBchWallet = createAsyncThunk(
  'walletconnect/setBchWallet',
  async (wallet: Wallet | TestNetWallet) => {
    // Retrieve an address. Replace getDepositAddress with your own logic.
    const walletAddress = wallet.getDepositAddress()
    console.log('[WalletconnectSlice] setBchWallet, address =', walletAddress)

    return { wallet, address: walletAddress }
  }
)

// ──────────────────────────────────────────────────────────────────────────
//  THUNK: Handle incoming session requests from the dApp
// ──────────────────────────────────────────────────────────────────────────
export const handleWcRequest = createAsyncThunk(
  'walletconnect/request',
  async (event: WalletKitTypes.SessionRequest, { getState }) => {
    const state = getState() as RootState
    const { web3wallet, bchWallet, walletAddress } = state.walletconnect

    if (!web3wallet) {
      console.error('[WalletconnectSlice] handleWcRequest: no web3wallet!')
      throw new Error('WalletConnect not initialized')
    }
    if (!bchWallet || !walletAddress) {
      console.warn('[WalletconnectSlice] handleWcRequest: no bchWallet or walletAddress set!')
      // Depending on your logic, you may want to throw or simply respond with an error:
      // throw new Error('No BCH wallet loaded')
      // or just proceed with an error response
    }

    const { topic, params, id } = event
    const { request } = params
    const method = request.method

    console.log('[WalletconnectSlice] handleWcRequest ->', method)
    console.log('[WalletconnectSlice] event details:', event)

    // Switch on method
    switch (method) {
      case 'bch_getAddresses':
      case 'bch_getAccounts': {
        // Return your main address. Possibly more logic needed for multi-account.
        const result = [walletAddress || '']  
        const response = { id, jsonrpc: '2.0', result }
        await web3wallet.respondSessionRequest({ topic, response })
        console.log(`[WalletconnectSlice] responded with address: ${result}`)
        break
      }

      case 'bch_signMessage':
      case 'personal_sign': {
        // Minimal sign message. Usually the dApp provides the message in request.params
        console.log('[WalletconnectSlice] signing message:', request.params)
        await signMessage(event, bchWallet)
        break
      }

      case 'bch_signTransaction': {
        console.log('[WalletconnectSlice] signing transaction request')
        await signTransactionWC(event, bchWallet)
        break
      }

      default: {
        // If unknown method, respond with an error
        const response = {
          id,
          jsonrpc: '2.0',
          error: { code: 1001, message: `Unsupported method ${method}` },
        }
        await web3wallet.respondSessionRequest({ topic, response })
        console.warn(`[WalletconnectSlice] Unsupported method: ${method}`)
      }
    }
  }
)

// ──────────────────────────────────────────────────────────────────────────
//  HELPER: Sign a message
// ──────────────────────────────────────────────────────────────────────────
async function signMessage(
  event: WalletKitTypes.SessionRequest,
  wallet: Wallet | TestNetWallet | null
) {
  if (!wallet) {
    console.error('[signMessage] no wallet found!')
    throw new Error('No BCH wallet loaded')
  }

  const { topic, params, id } = event
  const { request } = params
  const { message } = request.params

  console.log('[signMessage] Received message:', message)

  // The .sign() method is from mainnet-js
  const signedResult = await wallet.sign(message)

  // Example result includes signature
  // If your wallet returns a more complex object, adapt the line below
  const signature = signedResult?.signature ?? 'No signature'

  // Respond to WC
  const response = { id, jsonrpc: '2.0', result: signature }
  const state = (window as any).store?.getState()?.walletconnect // or handle differently
  if (state?.web3wallet) {
    await state.web3wallet.respondSessionRequest({ topic, response })
    console.log('[signMessage] responded to dApp with signature')
  } else {
    console.error('[signMessage] Could not respond - no web3wallet in store')
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  HELPER: Sign a transaction
// ──────────────────────────────────────────────────────────────────────────
async function signTransactionWC(
  event: WalletKitTypes.SessionRequest,
  wallet: Wallet | TestNetWallet | null
) {
  if (!wallet) {
    console.error('[signTransactionWC] no wallet found!')
    throw new Error('No BCH wallet loaded')
  }

  const { topic, params, id } = event
  const { request } = params

  console.log('[signTransactionWC] request:', request)
  // request.params might include: { transaction, sourceOutputs, broadcast }

  // For example:
  // const { transaction, sourceOutputs, broadcast } = request.params

  // Perform your signing logic here – see your Pinia code for advanced steps

  // As a placeholder, we just return a fake TX ID
  const dummySignedTx = {
    signedTransaction: 'FAKE_SIGNED_TX_HEX',
    signedTransactionHash: 'FAKE_SIGNED_TX_HASH',
  }

  // And respond
  const response = { id, jsonrpc: '2.0', result: dummySignedTx }

  const state = (window as any).store?.getState()?.walletconnect // or handle differently
  if (state?.web3wallet) {
    await state.web3wallet.respondSessionRequest({ topic, response })
    console.log('[signTransactionWC] responded to dApp with dummy transaction')
  } else {
    console.error('[signTransactionWC] Could not respond - no web3wallet in store')
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  HELPER: Reject a request
// ──────────────────────────────────────────────────────────────────────────
async function rejectRequest(event: WalletKitTypes.SessionRequest) {
  const { topic, params, id } = event
  const response = {
    id,
    jsonrpc: '2.0',
    error: getSdkError('USER_REJECTED'),
  }

  const state = (window as any).store?.getState()?.walletconnect
  if (state?.web3wallet) {
    await state.web3wallet.respondSessionRequest({ topic, response })
    console.log('[rejectRequest] Rejected request for method', params.request.method)
  } else {
    console.error('[rejectRequest] Could not respond - no web3wallet in store')
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  SLICE DEFINITION
// ──────────────────────────────────────────────────────────────────────────
const walletconnectSlice = createSlice({
  name: 'walletconnect',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    // initWalletConnect
    builder.addCase(initWalletConnect.fulfilled, (state, action) => {
      console.log('[WalletconnectSlice] initWalletConnect.fulfilled')
      state.web3wallet = action.payload.web3wallet
      state.activeSessions = action.payload.activeSessions
    })
    builder.addCase(initWalletConnect.rejected, (_, action) => {
      console.error('[WalletconnectSlice] initWalletConnect.rejected:', action.error)
    })

    // wcPair
    builder.addCase(wcPair.rejected, (_, action) => {
      console.error('[WalletconnectSlice] wcPair.rejected:', action.error)
    })

    // setBchWallet
    builder.addCase(setBchWallet.fulfilled, (state, action) => {
      const { wallet, address } = action.payload
      state.bchWallet = wallet
      state.walletAddress = address
      console.log('[WalletconnectSlice] bchWallet set. Address =', address)
    })
    builder.addCase(setBchWallet.rejected, (_, action) => {
      console.error('[WalletconnectSlice] setBchWallet.rejected:', action.error)
    })

    // handleWcRequest
    builder.addCase(handleWcRequest.rejected, (_, action) => {
      console.error('[WalletconnectSlice] handleWcRequest.rejected:', action.error)
    })
  },
})

export default walletconnectSlice.reducer
