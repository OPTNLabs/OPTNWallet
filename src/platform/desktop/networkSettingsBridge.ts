import { invoke } from '@tauri-apps/api/core';
import { Network } from '../../state/slices/networkSlice';
import { isDesktopPlatform } from '../../utils/platform';
import type { Backend } from './backendSelection';

const WIRE_PROTOCOL_VERSION = 1;

/** `Network` values are the Rust `optn_core::network::Network` names. */
function wireNetwork(network: Network): string {
  return network;
}

/** Persist the legacy desktop renderer's one-backend selection through Rust. */
export async function persistDesktopBackend(
  network: Network,
  backend: Backend
): Promise<void> {
  if (!isDesktopPlatform()) return;

  const servers =
    backend.kind === 'server'
      ? { electrum: backend.target }
      : backend.kind === 'node'
        ? { peer: backend.target }
        : {};
  await invoke('optn_app_dispatch', {
    action: {
      version: WIRE_PROTOCOL_VERSION,
      action: {
        type: 'replace_network_servers',
        value: { network: wireNetwork(network), servers },
      },
    },
  });
}
