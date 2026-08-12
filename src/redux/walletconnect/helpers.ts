import { buildApprovedNamespaces } from '@walletconnect/utils';
import { Toast } from '@capacitor/toast';
import type { IWalletKit, WalletKitTypes } from '@reown/walletkit';
import type { RootState } from '../store';
import KeyService from '../../services/KeyService';
import { PREFIX } from '../../utils/constants';
import { BCH_EVENTS, BCH_METHODS, CAIP2_BY_NETWORK } from './constants';
import type { SessionUpdateEmitter } from './types';

type SessionRequestResponder = {
  respondSessionRequest: (args: {
    topic: string;
    response:
      | { id: number; jsonrpc: '2.0'; result: unknown }
      | {
          id: number;
          jsonrpc: '2.0';
          error: { code: number; message: string };
        };
  }) => Promise<unknown>;
};

type WalletConnectListenerHandlers = {
  onProposal: (proposal: WalletKitTypes.SessionProposal) => void;
  onSessionUpdate: () => void;
  onSessionRequest: (sessionEvent: WalletKitTypes.SessionRequest) => void;
};

export function registerWalletConnectListeners(
  web3wallet: IWalletKit,
  handlers: WalletConnectListenerHandlers
) {
  web3wallet.on('session_proposal', async (proposal) => {
    await Toast.show({
      text: 'Session proposal from dApp! Check console or modal.',
    });
    handlers.onProposal(proposal);
  });

  const sessionEmitter = web3wallet as IWalletKit & SessionUpdateEmitter;
  sessionEmitter.on('session_update', () => {
    handlers.onSessionUpdate();
  });

  web3wallet.on('session_request', (sessionEvent) => {
    handlers.onSessionRequest(sessionEvent);
  });
}

export async function buildApprovedNamespacesForCurrentWallet(
  state: RootState,
  proposal: WalletKitTypes.SessionProposal
) {
  const currentNetwork = state.network.currentNetwork;
  const namespace = CAIP2_BY_NETWORK[currentNetwork];
  if (!namespace) {
    throw new Error(`Unsupported network for CAIP-2: ${currentNetwork}`);
  }

  const addressPrefix = PREFIX[currentNetwork];
  const keys = await KeyService.retrieveKeys(state.wallet_id.currentWalletId!);
  if (!keys.length) {
    throw new Error('No keys available for current wallet');
  }
  const accounts = keys.map((k) =>
    toWalletConnectAccount(k.address, namespace, addressPrefix)
  );

  return buildApprovedNamespaces({
    proposal: proposal.params,
    supportedNamespaces: {
      bch: {
        chains: [namespace],
        methods: BCH_METHODS,
        events: BCH_EVENTS,
        accounts,
      },
    },
  });
}

export function toWalletConnectAccount(
  address: string,
  namespace: string,
  addressPrefix: string
): string {
  const normalizedPrefix = addressPrefix.endsWith(':')
    ? addressPrefix
    : `${addressPrefix}:`;
  const bare = address.startsWith(normalizedPrefix)
    ? address.slice(normalizedPrefix.length)
    : address.includes(':')
      ? address.split(':').pop() ?? address
      : address;

  return `${namespace}:${bare}`;
}

export function normalizeWalletAddressCandidate(
  candidate: string,
  addressPrefix: string
): string | null {
  const value = candidate.trim();
  if (!value) return null;
  if (value.startsWith(addressPrefix)) return value;

  // CAIP-10 BCH account: bch:<chain>:<address_without_prefix>
  const caipMatch = /^bch:[^:]+:(.+)$/i.exec(value);
  if (caipMatch?.[1]) return `${addressPrefix}${caipMatch[1]}`;

  // Bare cashaddr payload (without prefix)
  if (!value.includes(':')) return `${addressPrefix}${value}`;

  return null;
}

export function extractWalletConnectMessage(
  signMsgRequest: WalletKitTypes.SessionRequest
): string {
  const params = signMsgRequest.params.request.params;
  if (Array.isArray(params)) {
    return params[0] ?? '';
  }
  return params?.message ?? '';
}

export async function respondSessionResult(
  walletKit: SessionRequestResponder,
  topic: string,
  id: number,
  result: unknown
) {
  await walletKit.respondSessionRequest({
    topic,
    response: { id, jsonrpc: '2.0', result },
  });
}

export async function respondSessionError(
  walletKit: SessionRequestResponder,
  topic: string,
  id: number,
  message: string
) {
  const response = {
    id,
    jsonrpc: '2.0' as const,
    error: { code: 1001, message },
  };
  await walletKit.respondSessionRequest({ topic, response });
  return response;
}
