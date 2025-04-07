// src/redux/walletconnectSlice.ts

import 'dotenv/config'
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit'
import { Core } from '@walletconnect/core'
import {
  WalletKit,
  type WalletKitTypes,
  type IWalletKit,
} from '@reown/walletkit'
import { getSdkError } from '@walletconnect/utils'
import type { SessionTypes } from '@walletconnect/types'
import type { RootState } from './store'
import KeyService from '../services/KeyService'

// -- Optional debug placeholders, so TS doesn't complain if they're unused.
import * as _Toast from '@capacitor/toast'
import * as _SignedMessage from '../utils/signed'
console.debug('[walletconnectSlice] Debug placeholders:', {
  ToastModule: _Toast,
  SignedMessageModule: _SignedMessage,
})

// JSON-RPC union types for success/error responses
type JsonRpcSuccess<T = unknown> = {
  id: number
  jsonrpc: '2.0'
  result: T
}
type JsonRpcError = {
  id: number
  jsonrpc: '2.0'
  error: {
    code: number
    message: string
  }
}
type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError

// Slice state
interface WalletconnectState {
  web3wallet: IWalletKit | null
  activeSessions: Record<string, SessionTypes.Struct> | null
  pendingProposal: WalletKitTypes.SessionProposal | null
}

const initialState: WalletconnectState = {
  web3wallet: null,
  activeSessions: null,
  pendingProposal: null,
}

// 1) initWalletConnect
export const initWalletConnect = createAsyncThunk(
  'walletconnect/init',
  async (_, { dispatch }) => {
    console.log('[WalletconnectSlice] initWalletConnect triggered')

    // Use your .env or inline project ID
    const projectId = 'f62aa2bb589104d059ca7b5bb64b18fb'
    console.log('[WalletconnectSlice] Using projectId:', projectId)

    const core = new Core({ projectId })
    console.log('[WalletconnectSlice] Created Core instance')

    // The metadata will appear on the dApp side
    const metadata = {
      name: 'OPTN Wallet',
      description: 'OPTN WalletConnect Integration',
      // For dev, match your local domain if you want to avoid mismatch warnings
      url: 'https://optn.cash',
      icons: ['https://optn.cash/logo.png'],
    }

    const web3wallet = await WalletKit.init({ core, metadata })
    console.log('[WalletconnectSlice] WalletKit initialized')

    const activeSessions = web3wallet.getActiveSessions()
    console.log('[WalletconnectSlice] Active sessions at init:', activeSessions)

    // ----------------------------
    // A) Listen for session_proposal
    // ----------------------------
    web3wallet.on('session_proposal', (proposal) => {
      console.log('[WalletconnectSlice] session_proposal event:', proposal)
      // store the proposal in Redux so we can show a modal
      dispatch(receiveSessionProposal(proposal))
    })

    // ----------------------------
    // B) Listen for session_request
    // ----------------------------
    web3wallet.on('session_request', (sessionEvent) => {
      console.log('[WalletconnectSlice] session_request event:', sessionEvent)
      dispatch(handleWcRequest(sessionEvent))
    })

    return { web3wallet, activeSessions }
  }
)

// 2) Session Proposal – Approve or Reject

// We'll store the proposal in Redux, so we define a simple action
export const receiveSessionProposal = createSlice({
  name: 'sessionProposal',
  initialState: null as WalletKitTypes.SessionProposal | null,
  reducers: {
    setProposal: (state, action) => action.payload,
  },
}).actions.setProposal

// Thunk: Approve the session proposal
export const approveSessionProposal = createAsyncThunk(
  'walletconnect/approveSessionProposal',
  async (_, { getState }) => {
    const state = getState() as RootState
    const walletKit = state.walletconnect.web3wallet
    const proposal = state.walletconnect.pendingProposal
    if (!walletKit || !proposal) {
      throw new Error('No walletKit or proposal to approve')
    }

    // Build minimal "namespaces" for BCH
    // e.g. define chain "bch:main" or "bch:test"
    const chainId = 'bch:main'
    const address = 'bitcoincash:qEXAMPLE...' // You can refine this from KeyService or user selection
    const accountCaip = `${chainId}:${address}`

    // If the dApp requests eip155 or something else, you'd need to handle that logic,
    // but let's force a bch namespace for demonstration
    const approvedNamespaces = {
      bch: {
        chains: [chainId],
        methods: [
          'bch_getAddresses',
          'bch_signMessage',
          'bch_signTransaction',
        ],
        events: [],
        accounts: [accountCaip],
      },
    }

    console.log('[WalletconnectSlice] Approving session with:', approvedNamespaces)
    // Approve the session
    const session = await walletKit.approveSession({
      id: proposal.id,
      namespaces: approvedNamespaces,
    })
    console.log('[WalletconnectSlice] session approved:', session)
    return session
  }
)

// Thunk: Reject the session proposal
export const rejectSessionProposal = createAsyncThunk(
  'walletconnect/rejectSessionProposal',
  async (_, { getState }) => {
    const state = getState() as RootState
    const walletKit = state.walletconnect.web3wallet
    const proposal = state.walletconnect.pendingProposal
    if (!walletKit || !proposal) {
      throw new Error('No walletKit or proposal to reject')
    }

    await walletKit.rejectSession({
      id: proposal.id,
      reason: getSdkError('USER_REJECTED'),
    })
    console.log('[WalletconnectSlice] session rejected')
  }
)

// 3) handleWcRequest
export const handleWcRequest = createAsyncThunk(
  'walletconnect/request',
  async (sessionEvent: WalletKitTypes.SessionRequest, { getState }) => {
    const state = getState() as RootState
    const walletKit = state.walletconnect.web3wallet
    const currentWalletId = state.wallet_id.currentWalletId
    if (!walletKit) {
      throw new Error('WalletConnect not initialized')
    }
    if (!currentWalletId) {
      throw new Error('No wallet selected – cannot fetch keys')
    }

    const { topic, params, id } = sessionEvent
    const { request } = params
    const method = request.method
    console.log(`[handleWcRequest] Incoming method: ${method}`)

    let response: JsonRpcResponse = {
      id,
      jsonrpc: '2.0',
      result: `Method ${method} not implemented yet.`,
    }

    switch (method) {
      case 'bch_getAccounts':
      case 'bch_getAddresses': {
        console.log('[handleWcRequest] bch_getAddresses triggered')
        const allKeys = await KeyService.retrieveKeys(currentWalletId)
        const addresses = allKeys.map((k) => k.address)
        response = { id, jsonrpc: '2.0', result: addresses }
        break
      }

      case 'bch_signMessage':
      case 'personal_sign': {
        console.log('[handleWcRequest] bch_signMessage triggered')
        // For demonstration, sign with the first address
        const allKeys = await KeyService.retrieveKeys(currentWalletId)
        if (!allKeys.length) {
          throw new Error('No keys found in DB!')
        }

        const addressObj = allKeys[0]
        const privateKey = await KeyService.fetchAddressPrivateKey(addressObj.address)
        if (!privateKey) {
          throw new Error('Private key not found')
        }

        // parse the message from request
        let message = ''
        if (Array.isArray(request.params) && request.params.length > 0) {
          message = request.params[0]
        } else if (typeof request.params === 'object' && request.params.message) {
          message = request.params.message
        } else {
          message = 'Hello from BCH (fallback)'
        }

        console.log('[handleWcRequest] Signing message:', message)

        // Actually sign (placeholder)
        // If using your SignedMessage class, do:
        //   const signedResult = await SignedMessage.sign(message, privateKey)
        //   const base64Sig = signedResult.signature
        //   response = { id, jsonrpc: '2.0', result: base64Sig }
        response = { id, jsonrpc: '2.0', result: 'PLACEHOLDER_SIGNATURE' }
        break
      }

      case 'bch_signTransaction': {
        console.log('[handleWcRequest] bch_signTransaction triggered')
        // Example: parse transaction details from request, sign inputs, etc.
        response = { id, jsonrpc: '2.0', result: '0xDEADBEEF' }
        break
      }

      default: {
        console.warn('[handleWcRequest] Unsupported method:', method)
        response = {
          id,
          jsonrpc: '2.0',
          error: {
            code: 1001,
            message: `Unsupported method: ${method}`,
          },
        }
        break
      }
    }

    console.log('[handleWcRequest] Responding with:', response)
    await walletKit.respondSessionRequest({ topic, response })
  }
)

// 4) Pair from typed or scanned URI
export const wcPair = createAsyncThunk(
  'walletconnect/pair',
  async (uri: string, { getState }) => {
    console.log('[walletconnectSlice] wcPair triggered with URI:', uri)
    const state = getState() as RootState
    const walletKit = state.walletconnect.web3wallet
    if (!walletKit) {
      throw new Error('WalletConnect is not initialized')
    }
    await walletKit.pair({ uri })
    console.log('[walletconnectSlice] Pairing attempt completed')
  }
)

const walletconnectSlice = createSlice({
  name: 'walletconnect',
  initialState,
  reducers: {
    // We'll store the proposal in Redux so a React modal can read it
    setPendingProposal: (state, action) => {
      state.pendingProposal = action.payload
    },
    clearPendingProposal: (state) => {
      state.pendingProposal = null
    },
  },
  extraReducers: (builder) => {
    builder.addCase(initWalletConnect.fulfilled, (state, action) => {
      console.log('[walletconnectSlice] initWalletConnect.fulfilled')
      state.web3wallet = action.payload.web3wallet
      state.activeSessions = action.payload.activeSessions
    })
    builder.addCase(initWalletConnect.rejected, (_, action) => {
      console.error('[walletconnectSlice] initWalletConnect.rejected:', action.error)
    })

    // handle session proposals
    builder.addCase(approveSessionProposal.fulfilled, (state, action) => {
      console.log('[walletconnectSlice] approveSessionProposal.fulfilled')
      state.pendingProposal = null
    })
    builder.addCase(approveSessionProposal.rejected, (_, action) => {
      console.error('[walletconnectSlice] approveSessionProposal.rejected:', action.error)
    })

    builder.addCase(rejectSessionProposal.fulfilled, (state) => {
      console.log('[walletconnectSlice] rejectSessionProposal.fulfilled')
      state.pendingProposal = null
    })
    builder.addCase(rejectSessionProposal.rejected, (_, action) => {
      console.error('[walletconnectSlice] rejectSessionProposal.rejected:', action.error)
    })

    // handle session requests
    builder.addCase(handleWcRequest.rejected, (_, action) => {
      console.error('[walletconnectSlice] handleWcRequest.rejected:', action.error)
    })

    // handle pairing
    builder.addCase(wcPair.rejected, (_, action) => {
      console.error('[walletconnectSlice] wcPair.rejected:', action.error)
    })
  },
})

export const { setPendingProposal, clearPendingProposal } = walletconnectSlice.actions
export default walletconnectSlice.reducer
