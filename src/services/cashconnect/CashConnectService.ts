import { MemoryStore } from '@cashconnect-js/nostr';
import {
  Wallet,
  doesActionRequireApproval,
  type WalletSession,
} from '@cashconnect-js/nostr/wallet';
import type {
  ExecuteActionRequest,
  ExecuteActionResponse,
  SessionCreateRequest,
  SessionProposalResponse,
} from '@cashconnect-js/nostr';
import WalletManager from '../../apis/WalletManager/WalletManager';
import { Network } from '../../state/slices/networkSlice';
import { subscribeWalletUtxoRefresh } from '../WalletUtxoRefreshService';
import { zeroize } from '../../utils/secureMemory';
import { logError } from '../../utils/errorHandling';

import {
  getChangeTemplateDirectiveForCashConnect,
  getSourceOutputForCashConnect,
  getSpendableUTXOsForCashConnect,
} from './cashconnectContext';
import { deriveCashConnectIdentityKey } from './cashconnectKey';

export type CashConnectProposalWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export type CashConnectActionWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

type Seed = {
  mnemonic: string;
  passphrase: string;
  network: Network;
  accountPath: string;
};

let wallet: Wallet | undefined;
let walletId = 0;
let proposalWaiter: CashConnectProposalWaiter | null = null;
let actionWaiter: CashConnectActionWaiter | null = null;
let unsubscribeUtxoRefresh: (() => void) | null = null;

type UiHooks = {
  onSessions: (sessions: Record<string, WalletSession>) => void;
  onProposal: (proposal: SessionProposalResponse) => void;
  onAction: (payload: {
    session: WalletSession;
    request: ExecuteActionRequest;
    response: ExecuteActionResponse;
  }) => void;
  onClearProposal: () => void;
  onClearAction: () => void;
  onError: (message: string) => void;
};

let hooks: UiHooks | null = null;

export function bindCashConnectUi(next: UiHooks): void {
  hooks = next;
}

function walletNetwork(info: { networkType?: Network | null }): Network {
  return info.networkType === Network.MAINNET ? Network.MAINNET : Network.CHIPNET;
}

function expectedChain(network: Network): SessionProposalResponse['chain'] {
  return network === Network.MAINNET ? 'bitcoincash' : 'bchtest';
}

function assertCashConnectActive(expectedWalletId: number): void {
  if (!wallet || walletId !== expectedWalletId) {
    throw new Error('CashConnect request aborted');
  }
}

export function isCashConnectActive(expectedWalletId: number): boolean {
  return wallet !== undefined && walletId === expectedWalletId;
}

export async function startCashConnect(nextWalletId: number): Promise<void> {
  if (wallet && walletId === nextWalletId) return;
  await stopCashConnect();

  const info = await WalletManager().getWalletInfo(nextWalletId);
  const metadata = await WalletManager().getWalletMetadata(nextWalletId);
  if (
    !info?.mnemonic ||
    metadata?.walletType === 'watch-only' ||
    metadata?.walletType === 'hardware'
  ) {
    return;
  }

  const nextSeed: Seed = {
    mnemonic: info.mnemonic,
    passphrase: info.passphrase ?? '',
    network: walletNetwork(info),
    accountPath: info.derivation_path,
  };
  const identityKey = await deriveCashConnectIdentityKey(nextSeed);
  let client: Wallet;
  try {
    client = new Wallet({
      cashConnectPrivateKey: identityKey,
      store: new MemoryStore<WalletSession>(),
      eventCallbacks: {
        onSessionsUpdated(sessions) {
          hooks?.onSessions(sessions);
        },
        onSessionProposal(proposal) {
          const walletChain = expectedChain(nextSeed.network);
          if (proposal.chain !== walletChain) {
            const dappNet =
              proposal.chain === 'bitcoincash' ? 'Mainnet' : 'Chipnet';
            const walletNet =
              nextSeed.network === Network.MAINNET ? 'Mainnet' : 'Chipnet';
            return Promise.reject(
              new Error(
                `This CashConnect dApp is ${dappNet}. This wallet is ${walletNet}. Open a ${dappNet} wallet to connect.`
              )
            );
          }
          hooks?.onProposal(proposal);
          return new Promise<SessionCreateRequest>((resolve, reject) => {
            proposalWaiter = {
              resolve: () =>
                resolve({ allowedTokens: proposal.allowedTokens ?? [] }),
              reject,
            };
          });
        },
        onExecuteAction(session, request, response, signal) {
          if (signal.aborted || !isCashConnectActive(nextWalletId)) {
            return Promise.reject(new Error('CashConnect request aborted'));
          }
          if (!doesActionRequireApproval(session, request.action)) {
            return Promise.resolve();
          }
          hooks?.onAction({ session, request, response });
          return new Promise<void>((resolve, reject) => {
            actionWaiter = { resolve, reject };
            signal.addEventListener(
              'abort',
              () => {
                hooks?.onClearAction();
                actionWaiter = null;
                reject(new Error('DApp cancelled the request'));
              },
              { once: true }
            );
          });
        },
        onError(error) {
          hooks?.onError(error.message);
        },
      },
      contextCallbacks: {
        getSpendableUTXOs: () => {
          assertCashConnectActive(nextWalletId);
          return getSpendableUTXOsForCashConnect(nextWalletId, nextSeed);
        },
        getChangeTemplateDirective: () => {
          assertCashConnectActive(nextWalletId);
          return getChangeTemplateDirectiveForCashConnect(
            nextWalletId,
            nextSeed
          );
        },
        getSourceOutput: (hash, index) => {
          assertCashConnectActive(nextWalletId);
          return getSourceOutputForCashConnect(hash, index);
        },
      },
    });
  } finally {
    zeroize(identityKey);
  }

  wallet = client;
  walletId = nextWalletId;
  unsubscribeUtxoRefresh = subscribeWalletUtxoRefresh((refreshedWalletId) => {
    if (refreshedWalletId !== nextWalletId) return;
    void notifyCashConnectBalancesChanged();
  });

  try {
    await client.start();
    if (wallet !== client) {
      throw new Error('CashConnect startup was cancelled');
    }
    hooks?.onSessions(client.getActiveSessions());
  } catch (error) {
    if (wallet === client) {
      wallet = undefined;
      walletId = 0;
    }
    try {
      await client.stop();
    } catch (stopError) {
      logError('CashConnectService.start.stopAfterFailure', stopError);
      throw stopError;
    }
    throw error;
  }
}

export async function stopCashConnect(): Promise<void> {
  proposalWaiter?.reject(new Error('CashConnect stopped'));
  actionWaiter?.reject(new Error('CashConnect stopped'));
  proposalWaiter = null;
  actionWaiter = null;
  hooks?.onClearProposal();
  hooks?.onClearAction();
  unsubscribeUtxoRefresh?.();
  unsubscribeUtxoRefresh = null;
  const previous = wallet;
  wallet = undefined;
  walletId = 0;
  if (previous) await previous.stop();
  hooks?.onSessions({});
}

export async function pairCashConnect(uri: string): Promise<void> {
  if (!wallet) throw new Error('CashConnect is not started');
  await wallet.pair(uri);
}

export async function disconnectCashConnectSession(
  dappPubkey: string
): Promise<void> {
  if (!wallet) return;
  await wallet.disconnectSession(dappPubkey);
}

export function approveCashConnectProposal(): void {
  proposalWaiter?.resolve();
  proposalWaiter = null;
  hooks?.onClearProposal();
}

export function rejectCashConnectProposal(): void {
  proposalWaiter?.reject(new Error('User rejected CashConnect session'));
  proposalWaiter = null;
  hooks?.onClearProposal();
}

export function approveCashConnectAction(): void {
  actionWaiter?.resolve();
  actionWaiter = null;
  hooks?.onClearAction();
}

export function rejectCashConnectAction(): void {
  actionWaiter?.reject(new Error('User cancelled'));
  actionWaiter = null;
  hooks?.onClearAction();
}

export async function notifyCashConnectBalancesChanged(): Promise<void> {
  try {
    await wallet?.notifyBalancesChanged();
  } catch (error) {
    logError('CashConnectService.notifyBalancesChanged', error);
  }
}

export function getCashConnectWallet(): Wallet | undefined {
  return wallet;
}
