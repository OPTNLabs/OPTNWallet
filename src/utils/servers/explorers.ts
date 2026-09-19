/**
 * Block explorer links — a call-through to the shared Rust core.
 *
 * This file used to hold the presets and build the URLs itself. That was a
 * selection rule living in the renderer, which is the thing
 * `chainSourcesBridge.ts` warns about: it is how a policy like "own
 * infrastructure only" ends up enforced on one surface and not another.
 *
 * Here the consequence was concrete. An explorer link is navigation, not chain
 * truth, so it was never routed through the connection policy — and a holder
 * who had restricted every chain source to their own nodes could still open a
 * transaction and hand its txid to blockchair.com. Nothing errored; the link
 * simply worked, which is what made it easy to miss.
 *
 * The decision now lives in `crates/optn-core/src/explorer.rs`, with the same
 * preset ids and templates, so a saved `explorerId` keeps resolving to the
 * explorer the holder picked. What changed is that every link is asked for
 * with the current chain policy, and a public explorer under a private policy
 * returns `null` instead of a URL.
 */

import {
  ensureOptnCore,
  explorerCustomUrl,
  explorerPolicyForChainPolicy,
  explorerPresetUrl,
  explorerPresets,
} from '../../wasm/optn-core';
import { Network } from '../../state/slices/networkSlice';

export type ExplorerPreset = {
  id: string;
  label: string;
  // Templates with {txid} / {address} / {block} placeholders. Mainnet.
  tx: string;
  address: string;
  block?: string;
  // Optional chipnet variant; if absent, the explorer has no testnet site and
  // the core falls back to a chipnet-specific default.
  chipnetTx?: string;
  chipnetAddress?: string;
};

/**
 * The chain connection policy, as `chainSourcesBridge.ts` names it.
 *
 * Passed through to the core rather than interpreted here: which policies
 * permit a public explorer is the kind of rule that must have one home.
 */
export type ExplorerChainPolicy = string;

/**
 * Default is BCH Explorer (bchexplorer.cash), Melroy van den Berg's
 * open-source explorer.
 *
 * A literal rather than a call, because `preferencesSlice` needs it while
 * building its initial state, before the core is necessarily instantiated.
 * `explorers.test.ts` pins it to the core's value so the two cannot drift.
 */
export const DEFAULT_EXPLORER_ID = 'bchexplorer';

let cachedPresets: ExplorerPreset[] | null = null;

/** Every preset the core will accept, for the settings picker. */
export function getExplorerPresets(): ExplorerPreset[] {
  if (cachedPresets === null) {
    ensureOptnCore();
    cachedPresets = JSON.parse(explorerPresets()) as ExplorerPreset[];
  }
  return cachedPresets;
}

export function getExplorerPreset(id: string): ExplorerPreset {
  const presets = getExplorerPresets();
  return presets.find((entry) => entry.id === id) ?? presets[0];
}

type ExplorerChoice =
  | { kind: 'preset'; id: string }
  | { kind: 'custom'; tx: string; address: string };

/**
 * `public-allowed`, `user-owned-only` or `disabled` for a chain policy.
 *
 * Exposed so a surface can say *why* a link is missing rather than rendering
 * nothing, which reads like a bug.
 */
export function explorerPolicyFor(policy: ExplorerChainPolicy): string {
  ensureOptnCore();
  return explorerPolicyForChainPolicy(policy);
}

function build(
  choice: ExplorerChoice,
  network: Network,
  kind: 'tx' | 'address',
  value: string,
  policy: ExplorerChainPolicy
): string | null {
  ensureOptnCore();
  try {
    return choice.kind === 'custom'
      ? explorerCustomUrl(
          choice.tx,
          choice.address,
          network,
          kind,
          value,
          policy
        )
      : explorerPresetUrl(choice.id, network, kind, value, policy);
  } catch {
    // Refused by policy, or a template/value the core will not put in a URL.
    // `null` is the honest answer: there is no link, and a caller that renders
    // one anyway would be the leak this exists to stop.
    return null;
  }
}

export function buildTxUrl(
  choice: ExplorerChoice,
  network: Network,
  txid: string,
  policy: ExplorerChainPolicy
): string | null {
  return build(choice, network, 'tx', txid, policy);
}

export function buildAddressUrl(
  choice: ExplorerChoice,
  network: Network,
  address: string,
  policy: ExplorerChainPolicy
): string | null {
  return build(choice, network, 'address', address, policy);
}

export type { ExplorerChoice };
