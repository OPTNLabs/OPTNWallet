import { invoke } from '@tauri-apps/api/core';
import type { Network } from '../../state/slices/networkSlice';
import { store } from '../../state/store';
import { selectWalletId } from '../../state/slices/walletSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import {
  selectTorEnabled,
  selectTorAuto,
  selectTorHost,
  selectTorPortManual,
} from '../../state/slices/experimentalSlice';
import type { RpaKeys } from '../../services/RpaService';
import type { RpaActivityPayload } from '../../services/WalletSpecialActivityService';
import { parseNodeTarget } from '../../utils/servers/userNodes';
import { activeNode } from './backendSelection';
import { getBirthHeight } from './DesktopWalletManager';
import { resolveFusionTransport } from './FusionTorResolver';

type Receipt = {
  txid: string;
  vout: number;
  address: string;
  value_sats: number;
  block_height: number | null;
  unspent: boolean;
  token: unknown | null;
  prevout_txid: string;
  prevout_index: number;
  sender_pubkey_hex: string;
};

/** Platform glue only: Rust owns discovery, proof validation and spend reconciliation. */
export async function scanNodeRpa(
  walletId: number,
  network: Network,
  keys: RpaKeys
): Promise<RpaActivityPayload> {
  const target = activeNode(network);
  if (!target) throw new Error('No BIP37 node selected.');
  const { host, port } = parseNodeTarget(target, network);
  const state = store.getState();
  const torRequired = selectTorEnabled(state);
  const route = torRequired
    ? await resolveFusionTransport(host, {
        enabled: true,
        auto: selectTorAuto(state),
        host: selectTorHost(state),
        manualPort: selectTorPortManual(state),
      })
    : { type: 'direct' as const };
  if (route.type === 'unavailable')
    throw new Error(`RPA node scan: ${route.reason}`);
  // Unknown birthday means full history, never silently scan only recent blocks.
  const fromHeight = (await getBirthHeight(walletId)) ?? 1;
  const scanPrivate = Array.from(keys.scanPrivkey);
  try {
    const result = await invoke<{
      receipts: Receipt[];
      includes_mempool: boolean;
    }>('cashcode_scan_node', {
      network,
      host,
      port,
      fromHeight,
      scanPrivate,
      spendPublic: Array.from(keys.spendPubkey),
      torRequired,
      torHost: route.type === 'tor' ? route.tor.host : null,
      torPort: route.type === 'tor' ? route.tor.port : null,
    });
    if (
      selectWalletId(store.getState()) !== walletId ||
      selectCurrentNetwork(store.getState()) !== network ||
      activeNode(network) !== target ||
      selectTorEnabled(store.getState()) !== torRequired
    ) {
      throw new Error(
        'Wallet, source or privacy policy changed during RPA scan.'
      );
    }
    // Token-bearing outputs must not enter the BCH-only RPA coin selector.
    const unspentOutputs = result.receipts
      .filter((r) => r.unspent && r.token == null)
      .map((r) => ({
        txHash: r.txid,
        outputIndex: r.vout,
        address: r.address,
        valueSats: r.value_sats,
        height: r.block_height ?? 0,
        rpaOrigin: {
          prevoutTxid: r.prevout_txid,
          prevoutIndex: r.prevout_index,
          senderPubkey: r.sender_pubkey_hex,
        },
      }));
    return {
      enabled: true,
      serverSupported: true,
      detectedPaymentCount: result.receipts.length,
      unspentOutputs,
      unspentOutputCount: unspentOutputs.length,
      unspentSats: unspentOutputs.reduce((sum, r) => sum + r.valueSats, 0),
      knownTxids: [...new Set(result.receipts.map((r) => r.txid))],
      ...(!result.includes_mempool
        ? {
            error:
              'BIP37 scan covers confirmed blocks; unconfirmed receipts and spends are not observed.',
          }
        : {}),
    };
  } finally {
    scanPrivate.fill(0);
  }
}
