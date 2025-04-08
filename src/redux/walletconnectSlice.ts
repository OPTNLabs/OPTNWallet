// src/redux/walletconnectSlice.ts

import 'dotenv/config'
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit'
import { Core } from '@walletconnect/core'
import {
  WalletKit,
  type WalletKitTypes,
  type IWalletKit,
} from '@reown/walletkit'
import { buildApprovedNamespaces, getSdkError } from '@walletconnect/utils'
import type { SessionTypes } from '@walletconnect/types'
import type { RootState } from './store'
import KeyService from '../services/KeyService'
import { Toast } from '@capacitor/toast'
import { SignedMessage } from '../utils/signed'
import { shortenTxHash } from '../utils/shortenHash'
import { PREFIX } from '../utils/constants'

// For BCH mainnet CAIP-2 is "bch:bitcoincash"
const BCH_CAIP2 = 'bch:bitcoincash'

// The methods and events the dApp is asking for
const BCH_METHODS = ['bch_getAddresses', 'bch_signMessage', 'bch_signTransaction']
const BCH_EVENTS = ['addressesChanged']

// JSON-RPC response shapes
type JsonRpcSuccess<T> = { id: number; jsonrpc: '2.0'; result: T }
type JsonRpcError = { id: number; jsonrpc: '2.0'; error: { code: number; message: string } }
type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError

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
    console.log('[walletconnectSlice] initWalletConnect triggered')

    const projectId = 'f62aa2bb589104d059ca7b5bb64b18fb' // place your real ID here
    console.log('[walletconnectSlice] Using projectId:', projectId)

    const core = new Core({ projectId })
    console.log('[walletconnectSlice] Created Core instance')

    const metadata = {
      name: 'OPTN Wallet',
      description: 'OPTN WalletConnect Integration',
      url: 'https://optnlabs.com',
      icons: ['https://optnlabs.com/logo.png'],
    }
    console.log('[walletconnectSlice] Using metadata:', metadata)

    // Initialize WalletKit
    const web3wallet = await WalletKit.init({ core, metadata })
    console.log('[walletconnectSlice] WalletKit initialized')

    // Check if there are existing sessions
    const activeSessions = web3wallet.getActiveSessions()
    console.log('[walletconnectSlice] Active sessions at init:', activeSessions)

    // Listen for session proposals
    web3wallet.on('session_proposal', async (proposal) => {
      console.log('[walletconnectSlice] session_proposal event:', proposal)
      // e.g. show a Toast or a modal
      await Toast.show({ text: 'Session proposal from dApp! Check console or a modal.' })
      // Save to Redux
      dispatch(setPendingProposal(proposal))
    })

    // Listen for session requests
    web3wallet.on('session_request', (sessionEvent) => {
      console.log('[walletconnectSlice] session_request event:', sessionEvent)
      dispatch(handleWcRequest(sessionEvent))
    })

    return { web3wallet, activeSessions }
  }
)

// 2) Approve or Reject a session proposal
export const approveSessionProposal = createAsyncThunk(
  'walletconnect/approveSessionProposal',
  async (_, { getState }) => {
    const state = getState() as RootState
    const walletKit = state.walletconnect.web3wallet
    const proposal = state.walletconnect.pendingProposal
    const currentNetwork = state.network.currentNetwork
    if (!walletKit || !proposal) {
      throw new Error('No walletKit or proposal to approve.')
    }

    // For demonstration, fetch the first address from KeyService
    const currentWalletId = state.wallet_id.currentWalletId
    const allKeys = await KeyService.retrieveKeys(currentWalletId)
    if (!allKeys.length) {
      throw new Error('No addresses found in DB!')
    }
    const firstAddress = allKeys[0].address

    // We must match the dApp's chain: "bch:bitcoincash"
    const { id, params } = proposal
    console.log(`[approveSessionProposal] Attempting to build namespaces for CAIP-10 address: ${BCH_CAIP2}:${firstAddress.slice(PREFIX[currentNetwork].length)}`)

    // The final accounts array must be fully qualified: "bch:bitcoincash:bitcoincash:qqxyz..." or "bch:bitcoincash:qqxyz..."
    // Typically it's "bch:bitcoincash:qqabc123" is enough
    let approvedNamespaces
    try {
      approvedNamespaces = buildApprovedNamespaces({
        proposal: params,
        supportedNamespaces: {
          bch: {
            chains: [BCH_CAIP2],            // e.g. "bch:bitcoincash"
            methods: BCH_METHODS,
            events: BCH_EVENTS,
            // CAIP-10 address: "bch:bitcoincash:qqsomeaddress..."
            accounts: [`${BCH_CAIP2}:${firstAddress.slice(PREFIX[currentNetwork].length)}`],
          },
        },
      })
    } catch (err) {
      console.error('[approveSessionProposal] error building namespaces:', err)
      throw new Error('Failed to build approved namespaces.')
    }

    // Approve session
    const session = await walletKit.approveSession({
      id,
      namespaces: approvedNamespaces,
    })

    console.log('[approveSessionProposal] session approved =>', session)
    return session
  }
)

// Reject
export const rejectSessionProposal = createAsyncThunk(
  'walletconnect/rejectSessionProposal',
  async (_, { getState }) => {
    const state = getState() as RootState
    const walletKit = state.walletconnect.web3wallet
    const proposal = state.walletconnect.pendingProposal
    if (!walletKit || !proposal) {
      throw new Error('No walletKit or proposal to reject.')
    }
    console.log('[rejectSessionProposal] user rejected =>', proposal.id)

    await walletKit.rejectSession({
      id: proposal.id,
      reason: getSdkError('USER_REJECTED'),
    })
    return true
  }
)

// 3) Handle session requests e.g. bch_getAddresses, bch_signMessage, etc.
export const handleWcRequest = createAsyncThunk(
  'walletconnect/request',
  async (sessionEvent: WalletKitTypes.SessionRequest, { getState }) => {
    const state = getState() as RootState
    const walletKit = state.walletconnect.web3wallet
    if (!walletKit) throw new Error('No walletKit')
    const currentWalletId = state.wallet_id.currentWalletId
    if (!currentWalletId) throw new Error('No wallet selected')

    const { topic, params, id } = sessionEvent
    const { request } = params
    const method = request.method
    console.log('[handleWcRequest] method =>', method)

    // Prepare a response
    let response: JsonRpcResponse<any> = {
      id,
      jsonrpc: '2.0',
      result: `Method ${method} not yet implemented`,
    }

    switch (method) {
      // bch_getAccounts or bch_getAddresses
      case 'bch_getAccounts':
      case 'bch_getAddresses': {
        const allKeys = await KeyService.retrieveKeys(currentWalletId)
        const addresses = allKeys.map((k) => k.address)
        response = { id, jsonrpc: '2.0', result: addresses }
        break
      }

      // bch_signMessage
      case 'bch_signMessage':
      case 'personal_sign': {
        const allKeys = await KeyService.retrieveKeys(currentWalletId)
        if (!allKeys.length) throw new Error('No keys found in DB!')

        const address = allKeys[0].address
        const privateKey = await KeyService.fetchAddressPrivateKey(address)
        if (!privateKey) throw new Error('No private key for address')

        // Figure out the message
        let message = ''
        if (Array.isArray(request.params) && request.params.length) {
          message = request.params[0]
        } else if (typeof request.params === 'object' && request.params?.message) {
          message = request.params.message
        } else {
          message = 'Hello from BCH fallback'
        }

        console.log(`[handleWcRequest] signing message => ${message.slice(0,30)}...`)
        const signatureResult = await SignedMessage.sign(message, privateKey)
        const base64Sig = signatureResult.signature

        response = { id, jsonrpc: '2.0', result: base64Sig }
        break
      }

      // bch_signTransaction
      case 'bch_signTransaction': {
        // parse the TX from request.params, sign with your code
        // for now we just return a placeholder
        response = { id, jsonrpc: '2.0', result: '0xDEADBEEF' }
        break
      }

      default: {
        response = {
          id,
          jsonrpc: '2.0',
          error: {
            code: 1001,
            message: `Unsupported method: ${method}`,
          },
        }
      }
    }

    console.log('[handleWcRequest] responding =>', response)
    await walletKit.respondSessionRequest({ topic, response })
  }
)

// 4) Pair from typed or scanned URI
export const wcPair = createAsyncThunk(
  'walletconnect/pair',
  async (uri: string, { getState }) => {
    const state = getState() as RootState
    const walletKit = state.walletconnect.web3wallet
    if (!walletKit) throw new Error('WalletKit not ready')

    console.log('[wcPair] pairing with =>', uri)
    await walletKit.pair({ uri })
    console.log('[wcPair] pairing done')
    await Toast.show({ text: 'Paired. Waiting for proposal...' })
  }
)

const walletconnectSlice = createSlice({
  name: 'walletconnect',
  initialState,
  reducers: {
    setPendingProposal: (state, action) => {
      console.log('[walletconnectSlice] setPendingProposal =>', action.payload)
      state.pendingProposal = action.payload
    },
    clearPendingProposal: (state) => {
      console.log('[walletconnectSlice] clearPendingProposal.')
      state.pendingProposal = null
    },
  },
  extraReducers: (builder) => {
    // init
    builder.addCase(initWalletConnect.fulfilled, (state, action) => {
      console.log('[initWalletConnect.fulfilled]')
      state.web3wallet = action.payload.web3wallet
      state.activeSessions = action.payload.activeSessions
    })
    builder.addCase(initWalletConnect.rejected, (_, action) => {
      console.error('[initWalletConnect.rejected]', action.error)
    })

    // approve
    builder.addCase(approveSessionProposal.fulfilled, (state, action) => {
      console.log('[approveSessionProposal.fulfilled] => session approved')
      state.pendingProposal = null
    })
    builder.addCase(approveSessionProposal.rejected, (_, action) => {
      console.error('[approveSessionProposal.rejected]', action.error)
    })

    // reject
    builder.addCase(rejectSessionProposal.fulfilled, (state) => {
      console.log('[rejectSessionProposal.fulfilled] => session rejected')
      state.pendingProposal = null
    })
    builder.addCase(rejectSessionProposal.rejected, (_, action) => {
      console.error('[rejectSessionProposal.rejected]', action.error)
    })

    // request
    builder.addCase(handleWcRequest.rejected, (_, action) => {
      console.error('[handleWcRequest.rejected]', action.error)
    })

    // pair
    builder.addCase(wcPair.rejected, (_, action) => {
      console.error('[wcPair.rejected]', action.error)
    })
  },
})

export const { setPendingProposal, clearPendingProposal } = walletconnectSlice.actions
export default walletconnectSlice.reducer
