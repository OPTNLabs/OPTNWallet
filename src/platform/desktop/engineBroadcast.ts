import { invoke } from '@tauri-apps/api/core';
import { store } from '../../state/store';

type BroadcastResponse = {
  txid: string;
  status: 'accepted' | 'uncertain' | 'rejected' | 'deferred';
  message: string | null;
};

/** Transport only: Rust validates the signed bytes, session, holds and route. */
export async function submitSignedTransaction(
  rawHex: string,
  walletId: number | null,
  sessionGeneration: number,
  network: string
): Promise<BroadcastResponse> {
  let submitted = false;
  const stillSelected = () => {
    const state = store.getState();
    return (
      state.wallet_id.currentWalletId === walletId &&
      (state.wallet_id.sessionGeneration ?? 0) === sessionGeneration &&
      state.network.currentNetwork === network
    );
  };
  try {
    if (!walletId || !stillSelected()) {
      throw new Error('Wallet session changed. Review the transaction again.');
    }
    const session = await invoke<{
      active: string | null;
      legacy_source_id: number | null;
      epoch: number;
    }>('optn_wallet_security', { request: { command: 'status' } });
    if (
      !stillSelected() ||
      !session.active ||
      session.legacy_source_id !== walletId ||
      !Number.isSafeInteger(session.epoch) ||
      session.epoch < 0
    ) {
      throw new Error('Open this wallet in the shared engine before sending.');
    }
    submitted = true;
    const response = await invoke<BroadcastResponse>('optn_wallet_broadcast', {
      request: {
        wallet_id: walletId,
        epoch: session.epoch,
        network,
        raw_hex: rawHex,
      },
    });
    if (
      !response ||
      typeof response.txid !== 'string' ||
      !['accepted', 'uncertain', 'rejected', 'deferred'].includes(
        response.status
      )
    ) {
      throw new Error('Invalid broadcast response.');
    }
    return response;
  } catch {
    // An IPC failure after handoff cannot prove that the transaction was not sent.
    // Never fall back to CashScript's independent network connection.
    return {
      txid: '',
      status: submitted ? 'uncertain' : 'deferred',
      message: submitted
        ? 'Network broadcast outcome is unknown. Refresh history before retrying.'
        : 'Wallet session is unavailable or changed. Reopen this wallet before sending.',
    };
  }
}
