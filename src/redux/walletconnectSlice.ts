// src/redux/walletconnectSlice.ts

import 'dotenv/config';
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import {
  importWalletTemplate,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBCH,
  generateTransaction,
  encodeTransaction,
  sha256,
  binToHex,
  hexToBin,
  type TransactionCommon,
  type TransactionTemplateFixed,
  type Input,
  type Output,
} from '@bitauth/libauth';
import { Core } from '@walletconnect/core';
import {
  WalletKit,
  type WalletKitTypes,
  type IWalletKit,
} from '@reown/walletkit';
import { buildApprovedNamespaces, getSdkError } from '@walletconnect/utils';
import type { SessionTypes } from '@walletconnect/types';
import type { RootState } from './store';
import KeyService from '../services/KeyService';
import { Toast } from '@capacitor/toast';
import { SignedMessage } from '../utils/signed';
import { PREFIX } from '../utils/constants';
import { parseExtendedJson } from '../utils/parseExtendedJson';
import TransactionService from '../services/TransactionService';

// For BCH mainnet, the CAIP-2 format for Bitcoin Cash is "bch:bitcoincash"
const BCH_CAIP2 = 'bch:bitcoincash';

// The methods and events required by the dApp
const BCH_METHODS = [
  'bch_getAddresses',
  'bch_signMessage',
  'bch_signTransaction',
];
const BCH_EVENTS = ['addressesChanged'];

// JSON-RPC response shapes
type JsonRpcSuccess<T> = { id: number; jsonrpc: '2.0'; result: T };
type JsonRpcError = {
  id: number;
  jsonrpc: '2.0';
  error: { code: number; message: string };
};
type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError;

// Extend our slice state with pending sign request properties
interface WalletconnectState {
  web3wallet: IWalletKit | null;
  activeSessions: Record<string, SessionTypes.Struct> | null;
  pendingProposal: WalletKitTypes.SessionProposal | null;
  pendingSignMsg: WalletKitTypes.SessionRequest | null;
  pendingSignTx: WalletKitTypes.SessionRequest | null;
}

const initialState: WalletconnectState = {
  web3wallet: null,
  activeSessions: null,
  pendingProposal: null,
  pendingSignMsg: null,
  pendingSignTx: null,
};

// 1) Initialize WalletConnect
export const initWalletConnect = createAsyncThunk(
  'walletconnect/init',
  async (_, { dispatch }) => {
    console.log('[walletconnectSlice] initWalletConnect triggered');

    const projectId = 'f62aa2bb589104d059ca7b5bb64b18fb';
    console.log('[walletconnectSlice] Using projectId:', projectId);

    const core = new Core({ projectId });
    console.log('[walletconnectSlice] Created Core instance');

    const metadata = {
      name: 'OPTN Wallet',
      description: 'OPTN WalletConnect Integration',
      url: 'https://optnlabs.com',
      icons: ['https://optnlabs.com/logo.png'],
    };
    console.log('[walletconnectSlice] Using metadata:', metadata);

    const web3wallet = await WalletKit.init({ core, metadata });
    console.log('[walletconnectSlice] WalletKit initialized');

    const activeSessions = web3wallet.getActiveSessions();
    console.log(
      '[walletconnectSlice] Active sessions at init:',
      activeSessions
    );
    

    // Listen for session proposals
    web3wallet.on('session_proposal', async (proposal) => {
      console.log('[walletconnectSlice] session_proposal event:', proposal);
      await Toast.show({
        text: 'Session proposal from dApp! Check console or modal.',
      });
      dispatch(setPendingProposal(proposal));
    });

    // once the peer actually settles the session, fire a "session_update"
    // we cast to any to avoid the built‑in Event typing, and just re‑pull all sessions
    (web3wallet as any).on("session_update", () => {
      console.log("🟢 session_update fired, refreshing active sessions");
      dispatch(setActiveSessions(web3wallet.getActiveSessions()));
    });

    // Listen for session requests
    web3wallet.on('session_request', (sessionEvent) => {
      console.log('[walletconnectSlice] session_request event:', sessionEvent);
      dispatch(handleWcRequest(sessionEvent));
    });

    return { web3wallet, activeSessions };
  }
);

// 2) Approve or Reject a session proposal
export const approveSessionProposal = createAsyncThunk(
  'walletconnect/approveSessionProposal',
  async (_, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    const proposal = state.walletconnect.pendingProposal;
    const currentNetwork = state.network.currentNetwork;
    if (!walletKit || !proposal) {
      throw new Error('No walletKit or proposal to approve.');
    }

    const currentWalletId = state.wallet_id.currentWalletId;
    const allKeys = await KeyService.retrieveKeys(currentWalletId);
    if (!allKeys.length) {
      throw new Error('No addresses found in DB!');
    }
    const firstAddress = allKeys[0].address;
    console.log('Retrieved firstAddress:', firstAddress);

    // Derive the CAIP-10 account string. Assume PREFIX[currentNetwork] returns "bitcoincash:"
    const derivedAccount = `${BCH_CAIP2}${firstAddress.slice(PREFIX[currentNetwork].length)}`;
    console.log('Derived CAIP-10 account:', derivedAccount);

    // Build namespaces with debug log
    const { id, params } = proposal;
    console.log(
      `[approveSessionProposal] Attempting to build namespaces for CAIP-10 address: ${derivedAccount}`
    );

    let approvedNamespaces;
    try {
      approvedNamespaces = buildApprovedNamespaces({
        proposal: params,
        supportedNamespaces: {
          bch: {
            chains: [BCH_CAIP2], // Expected to be "bch:bitcoincash"
            methods: BCH_METHODS,
            events: BCH_EVENTS,
            accounts: [derivedAccount],
          },
        },
      });
    } catch (err) {
      console.error('[approveSessionProposal] error building namespaces:', err);
      throw new Error('Failed to build approved namespaces.');
    }

    // Approve session with the built namespaces
    const session = await walletKit.approveSession({
      id,
      namespaces: approvedNamespaces,
    });

    console.log('[approveSessionProposal] session approved =>', session);
    return session;
  }
);

export const rejectSessionProposal = createAsyncThunk(
  'walletconnect/rejectSessionProposal',
  async (_, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    const proposal = state.walletconnect.pendingProposal;
    if (!walletKit || !proposal) {
      throw new Error('No walletKit or proposal to reject.');
    }
    console.log('[rejectSessionProposal] user rejected =>', proposal.id);
    await Toast.show({ text: 'Rejecting session...' });

    await walletKit.rejectSession({
      id: proposal.id,
      reason: getSdkError('USER_REJECTED'),
    });
    return true;
  }
);

// 3) Handle session requests (e.g. bch_getAddresses, bch_signMessage, bch_signTransaction)
export const handleWcRequest = createAsyncThunk(
  'walletconnect/request',
  async (
    sessionEvent: WalletKitTypes.SessionRequest,
    { getState, dispatch }
  ) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    if (!walletKit) throw new Error('WalletConnect not initialized');
    const currentWalletId = state.wallet_id.currentWalletId;
    if (!currentWalletId) throw new Error('No wallet selected');

    const { topic, params, id } = sessionEvent;
    const { request } = params;
    const method = request.method;
    console.log('[handleWcRequest] method =>', method);

    let response: JsonRpcResponse<unknown> | undefined;

    switch (method) {
      case 'bch_getAccounts':
      case 'bch_getAddresses': {
        const allKeys = await KeyService.retrieveKeys(currentWalletId);
        const addresses = allKeys.map((k) => k.address);
        response = { id, jsonrpc: '2.0', result: addresses };
        break;
      }
      case 'bch_signMessage':
      case 'personal_sign': {
        dispatch(setPendingSignMsg(sessionEvent));
        return;
      }
      case 'bch_signTransaction': {
        dispatch(setPendingSignTx(sessionEvent));
        return;
      }
      default: {
        response = {
          id,
          jsonrpc: '2.0',
          error: { code: 1001, message: `Unsupported method: ${method}` },
        };
      }
    }
    if (response) {
      console.log('[handleWcRequest] responding =>', response);
      await walletKit.respondSessionRequest({ topic, response });
    }
  }
);

// 4) Pair from typed or scanned URI
export const wcPair = createAsyncThunk(
  'walletconnect/pair',
  async (uri: string, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    if (!walletKit) throw new Error('WalletKit not ready');
    console.log('[wcPair] pairing with =>', uri);
    await walletKit.pair({ uri });
    console.log('[wcPair] pairing done');
    await Toast.show({ text: 'Paired. Waiting for proposal...' });
  }
);

export const disconnectSession = createAsyncThunk(
  'walletconnect/disconnectSession',
  async (topic: string, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    if (!walletKit) throw new Error('WalletConnect not initialized');
    console.log('[disconnectSession] disconnecting session for topic:', topic);
    await walletKit.disconnectSession({
      topic,
      reason: getSdkError('USER_DISCONNECTED'),
    });
    // Optionally update active sessions after disconnecting:
    const updatedSessions = walletKit.getActiveSessions();
    return updatedSessions;
  }
);

export const respondWithMessageSignature = createAsyncThunk(
  'walletconnect/respondWithMessageSignature',
  async (signMsgRequest: WalletKitTypes.SessionRequest, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    const currentWalletId = state.wallet_id.currentWalletId;
    if (!walletKit) throw new Error('WalletKit not initialized');
    const allKeys = await KeyService.retrieveKeys(currentWalletId);
    if (!allKeys.length) throw new Error('No keys in DB');
    const address = allKeys[0].address;
    const privKey = await KeyService.fetchAddressPrivateKey(address);
    if (!privKey) throw new Error('No private key found');
    const { id, topic, params } = signMsgRequest;
    let message = '';
    if (Array.isArray(params.request.params)) {
      message = params.request.params[0] ?? '';
    } else {
      message = params.request.params?.message ?? '';
    }
    const signedMsgResult = await SignedMessage.sign(message, privKey);
    const base64Signature = signedMsgResult.signature;
    await walletKit.respondSessionRequest({
      topic,
      response: { id, jsonrpc: '2.0', result: base64Signature },
    });
    return base64Signature;
  }
);

// (Include respondWithMessageError thunk here as shown above)

export const respondWithTxSignature = createAsyncThunk(
  'walletconnect/respondWithTxSignature',
  async (signTxRequest: WalletKitTypes.SessionRequest, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    if (!walletKit) throw new Error('WalletKit not initialized');

    /******** 1.  Grab the payload sent by the dApp *************************/
    const { id, topic, params } = signTxRequest;
    // Some dApps send “extended‑json” (numbers as strings, BigInt, etc.)
    const rawParams = params.request.params as any;
    const request = parseExtendedJson
      ? parseExtendedJson(JSON.stringify(rawParams))
      : rawParams;

    const txDetails = request.transaction as TransactionCommon;
    const sourceOutputs = request.sourceOutputs as
      | (Input & Output)[]
      | undefined;
    if (!txDetails || !sourceOutputs) {
      throw new Error('Malformed WalletConnect transaction request');
    }

    /******** 2.  Fetch user key ********************************************/
    const walletId = state.wallet_id.currentWalletId;
    const [firstKey] = await KeyService.retrieveKeys(walletId);
    if (!firstKey) throw new Error('No key available');
    const privKey = await KeyService.fetchAddressPrivateKey(firstKey.address);
    if (!privKey) throw new Error('Private key not found');

    /******** 3.  Build libauth compiler ************************************/
    const template = importWalletTemplate(walletTemplateP2pkhNonHd);
    if (typeof template === 'string') throw new Error(template); // template error
    const compiler = walletTemplateToCompilerBCH(template);

    /******** 4.  Fill every input with an unlocking script *****************/
    const txTemplate = { ...txDetails } as TransactionTemplateFixed<
      typeof compiler
    >;

    txTemplate.inputs.forEach((input, i) => {
      const utxo = sourceOutputs[i];
      input.unlockingBytecode = {
        compiler,
        data: { keys: { privateKeys: { key: privKey } } },
        valueSatoshis: utxo.valueSatoshis,
        script: 'unlock', // standard P2PKH unlock function
        token: utxo.token, // undefined for BCH, present for CashTokens
      };
    });

    /******** 5.  Generate & encode signed tx ******************************/
    const generated = generateTransaction(txTemplate);
    if (!generated.success) {
      throw new Error('Transaction signing failed');
    }
    const rawTx = encodeTransaction(generated.transaction);
    const txid = binToHex(sha256.hash(sha256.hash(rawTx)).reverse());

    const signedTxObject = {
      signedTransaction: binToHex(rawTx),
      signedTransactionHash: txid,
    };

    /******** 6.  (optional) broadcast *************************************/
    if (request.broadcast) {
      try {
        // You can broadcast with whatever API you already use
        await TransactionService.sendTransaction(binToHex(rawTx));
      } catch (e) {
        console.error('Broadcast failed', e);
        // Still return the signed hex – responsibility of the dApp.
      }
    }

    /******** 7.  Reply to WalletConnect ************************************/
    await walletKit.respondSessionRequest({
      topic,
      response: { id, jsonrpc: '2.0', result: signedTxObject },
    });

    return signedTxObject; // reducer will clear pendingSignTx
  }
);

export const respondWithTxError = createAsyncThunk(
  'walletconnect/respondWithTxError',
  async (signTxRequest: WalletKitTypes.SessionRequest, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    if (!walletKit) throw new Error('WalletKit not initialized');
    const { id, topic } = signTxRequest;
    const response = {
      id,
      jsonrpc: '2.0',
      error: { code: 1001, message: 'User rejected transaction signing' },
    };
    await walletKit.respondSessionRequest({ topic, response });
    return response;
  }
);

// Thunk for responding with message signing error
export const respondWithMessageError = createAsyncThunk(
  'walletconnect/respondWithMessageError',
  async (signMsgRequest: WalletKitTypes.SessionRequest, { getState }) => {
    const state = getState() as RootState;
    const walletKit = state.walletconnect.web3wallet;
    if (!walletKit) throw new Error('WalletKit not initialized');
    const { id, topic } = signMsgRequest;
    const response = {
      id,
      jsonrpc: '2.0',
      error: { code: 1001, message: 'User rejected message signing' },
    };
    await walletKit.respondSessionRequest({ topic, response });
    return response;
  }
);

// Reducer actions for setting pending sign requests
const walletconnectSlice = createSlice({
  name: 'walletconnect',
  initialState,
  reducers: {
    setPendingProposal: (state, action) => {
      console.log('[walletconnectSlice] setPendingProposal =>', action.payload);
      state.pendingProposal = action.payload;
    },
    clearPendingProposal: (state) => {
      console.log('[walletconnectSlice] clearPendingProposal.');
      state.pendingProposal = null;
    },
    setPendingSignMsg: (state, action) => {
      console.log('[walletconnectSlice] setPendingSignMsg =>', action.payload);
      state.pendingSignMsg = action.payload;
    },
    clearPendingSignMsg: (state) => {
      console.log('[walletconnectSlice] clearPendingSignMsg.');
      state.pendingSignMsg = null;
    },
    setPendingSignTx: (state, action) => {
      console.log('[walletconnectSlice] setPendingSignTx =>', action.payload);
      state.pendingSignTx = action.payload;
    },
    clearPendingSignTx: (state) => {
      console.log('[walletconnectSlice] clearPendingSignTx.');
      state.pendingSignTx = null;
    },
    setActiveSessions: (state, action: PayloadAction<Record<string, SessionTypes.Struct>>) => {
      state.activeSessions = action.payload;
    },
  },
  extraReducers: (builder) => {
    // Initialization
    builder.addCase(initWalletConnect.fulfilled, (state, action) => {
      console.log('[initWalletConnect.fulfilled]');
      state.web3wallet = action.payload.web3wallet;
      state.activeSessions = action.payload.activeSessions;
    });
    builder.addCase(initWalletConnect.rejected, (_, action) => {
      console.error('[initWalletConnect.rejected]', action.error);
    });

    // Approve proposal
    builder.addCase(approveSessionProposal.fulfilled, (state, _action) => {
      console.log('[approveSessionProposal.fulfilled] => session approved');
      state.pendingProposal = null;
      // pull in the newly‑approved session so the UI updates immediately:
      if (state.web3wallet) {
        state.activeSessions = state.web3wallet.getActiveSessions();
      }
    });

    builder.addCase(approveSessionProposal.rejected, (_, action) => {
      console.error('[approveSessionProposal.rejected]', action.error);
    });

    // Reject proposal
    builder.addCase(rejectSessionProposal.fulfilled, (state) => {
      console.log('[rejectSessionProposal.fulfilled] => session rejected');
      state.pendingProposal = null;
      // pull in the newly‑approved session:
  if (state.web3wallet) {
    state.activeSessions = state.web3wallet.getActiveSessions()
  }
    });
    builder.addCase(rejectSessionProposal.rejected, (_, action) => {
      console.error('[rejectSessionProposal.rejected]', action.error);
    });

    // Session requests
    builder.addCase(handleWcRequest.rejected, (_, action) => {
      console.error('[handleWcRequest.rejected]', action.error);
    });

    // Pairing
    builder.addCase(wcPair.rejected, (_, action) => {
      console.error('[wcPair.rejected]', action.error);
    });

    // disconnect session
    builder.addCase(disconnectSession.fulfilled, (state, action) => {
      console.log(
        '[disconnectSession.fulfilled] Updated active sessions',
        action.payload
      );
      state.activeSessions = action.payload;
    });
    builder.addCase(disconnectSession.rejected, (_, action) => {
      console.error('[disconnectSession.rejected]', action.error);
    });

    builder
      .addCase(respondWithMessageSignature.fulfilled, (s) => {
        s.pendingSignMsg = null;
      })
      .addCase(respondWithMessageError.fulfilled, (s) => {
        s.pendingSignMsg = null;
      })
      .addCase(respondWithTxSignature.fulfilled, (s) => {
        s.pendingSignTx = null;
      })
      .addCase(respondWithTxError.fulfilled, (s) => {
        s.pendingSignTx = null;
      });
  },
});

export const {
  setPendingProposal,
  setActiveSessions,
  clearPendingProposal,
  setPendingSignMsg,
  clearPendingSignMsg,
  setPendingSignTx,
  clearPendingSignTx,
} = walletconnectSlice.actions;
export default walletconnectSlice.reducer;
