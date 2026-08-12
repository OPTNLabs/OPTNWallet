// Block explorer presets + URL building.
//
// Explorers differ in their path scheme (/tx/ vs /transaction/), so each preset
// stores templates with a {txid} / {address} / {block} placeholder rather than
// assuming one shape. Default is BCH Explorer (bchexplorer.cash, Melroy van den
// Berg's open-source explorer).

import { Network } from '../../state/slices/networkSlice';

export type ExplorerPreset = {
  id: string;
  label: string;
  // Templates with {txid} / {address} / {block} placeholders. Mainnet.
  tx: string;
  address: string;
  block?: string;
  // Optional chipnet variant; if absent, the explorer has no testnet site and
  // the app falls back to a chipnet-specific default.
  chipnetTx?: string;
  chipnetAddress?: string;
};

export const EXPLORER_PRESETS: ExplorerPreset[] = [
  {
    id: 'bchexplorer',
    label: 'BCH Explorer (bchexplorer.cash)',
    tx: 'https://bchexplorer.cash/tx/{txid}',
    address: 'https://bchexplorer.cash/address/{address}',
    block: 'https://bchexplorer.cash/block/{block}',
    chipnetTx: 'https://bchexplorer.cash/chipnet/tx/{txid}',
    chipnetAddress: 'https://bchexplorer.cash/chipnet/address/{address}',
  },
  {
    id: 'bch-ninja',
    label: 'explorer.bch.ninja',
    tx: 'https://explorer.bch.ninja/tx/{txid}',
    address: 'https://explorer.bch.ninja/address/{address}',
    chipnetTx: 'https://chipnet.bch.ninja/tx/{txid}',
    chipnetAddress: 'https://chipnet.bch.ninja/address/{address}',
  },
  {
    id: 'imaginary',
    label: 'explorer.imaginary.cash',
    tx: 'https://explorer.imaginary.cash/tx/{txid}',
    address: 'https://explorer.imaginary.cash/address/{address}',
  },
  {
    id: 'blockchair',
    label: 'Blockchair',
    tx: 'https://blockchair.com/bitcoin-cash/transaction/{txid}',
    address: 'https://blockchair.com/bitcoin-cash/address/{address}',
  },
  {
    id: '3xpl',
    label: '3xpl',
    tx: 'https://3xpl.com/bitcoin-cash/transaction/{txid}',
    address: 'https://3xpl.com/bitcoin-cash/address/{address}',
  },
  {
    id: 'tokenexplorer',
    label: 'TokenExplorer (CashTokens)',
    tx: 'https://tokenexplorer.cash/?tx={txid}',
    address: 'https://tokenexplorer.cash/?address={address}',
  },
];

export const DEFAULT_EXPLORER_ID = 'bchexplorer';

// Chipnet has no BCH Explorer site, so testnet links fall back here regardless
// of the chosen mainnet explorer (unless that explorer defines its own chipnet).
const CHIPNET_FALLBACK = {
  tx: 'https://chipnet.bch.ninja/tx/{txid}',
  address: 'https://chipnet.bch.ninja/address/{address}',
};

export function getExplorerPreset(id: string): ExplorerPreset {
  return EXPLORER_PRESETS.find((e) => e.id === id) ?? EXPLORER_PRESETS[0];
}

type ExplorerChoice =
  | { kind: 'preset'; id: string }
  | { kind: 'custom'; tx: string; address: string };

function fill(template: string, key: 'txid' | 'address' | 'block', value: string): string {
  return template.replace(`{${key}}`, value);
}

export function buildTxUrl(choice: ExplorerChoice, network: Network, txid: string): string {
  if (choice.kind === 'custom') return fill(choice.tx, 'txid', txid);
  const preset = getExplorerPreset(choice.id);
  if (network === Network.CHIPNET) {
    return fill(preset.chipnetTx ?? CHIPNET_FALLBACK.tx, 'txid', txid);
  }
  return fill(preset.tx, 'txid', txid);
}

export function buildAddressUrl(choice: ExplorerChoice, network: Network, address: string): string {
  if (choice.kind === 'custom') return fill(choice.address, 'address', address);
  const preset = getExplorerPreset(choice.id);
  if (network === Network.CHIPNET) {
    return fill(preset.chipnetAddress ?? CHIPNET_FALLBACK.address, 'address', address);
  }
  return fill(preset.address, 'address', address);
}

export type { ExplorerChoice };
