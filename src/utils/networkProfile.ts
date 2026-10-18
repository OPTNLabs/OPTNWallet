import { Network } from '../state/slices/networkSlice';
import type { TranslationKey } from '../i18n/resources';

export type CashAddressPrefix = 'bitcoincash' | 'bchtest';

/**
 * What the wallet needs to know about one network.
 *
 * `NETWORK_PROFILES` is a `Record<Network, NetworkProfile>`, so a new `Network`
 * value does not compile until its row exists here. That is what keeps a screen
 * from quietly treating an unknown network as mainnet or chipnet. Where an
 * integration (Cauldron, Paryon, a faucet) is deployed stays with that
 * integration, keyed by `Network` the same way.
 */
export interface NetworkProfile {
  readonly network: Network;
  /** Proper-noun name for logs, file names and untranslated labels. */
  readonly label: string;
  readonly labelKey: TranslationKey;
  readonly descriptionKey: TranslationKey;
  /** Accent used by the network picker. */
  readonly color: string;
  readonly cashAddressPrefix: CashAddressPrefix;
  /** BIP32 version family: xpub on mainnet, tpub on every test network. */
  readonly hdNetwork: 'mainnet' | 'testnet';
  /** SLIP-44 coin type for new wallets. */
  readonly coinType: number;
  /** Coin types to try, in order, when discovering an imported wallet's path. */
  readonly discoveryCoinTypes: readonly number[];
  readonly unit: 'BCH' | 'tBCH';
  readonly isTestnet: boolean;
}

const TEST_NETWORK_KEYS = {
  cashAddressPrefix: 'bchtest',
  hdNetwork: 'testnet',
  coinType: 1,
  discoveryCoinTypes: [1, 145, 0],
  unit: 'tBCH',
  isTestnet: true,
} as const;

export const NETWORK_PROFILES: Readonly<Record<Network, NetworkProfile>> = {
  [Network.MAINNET]: {
    network: Network.MAINNET,
    label: 'Mainnet',
    labelKey: 'settingsNetwork.mainnet',
    descriptionKey: 'settingsNetwork.mainnetDescription',
    color: '#22c55e',
    cashAddressPrefix: 'bitcoincash',
    hdNetwork: 'mainnet',
    coinType: 145,
    discoveryCoinTypes: [145, 0],
    unit: 'BCH',
    isTestnet: false,
  },
  [Network.TESTNET3]: {
    network: Network.TESTNET3,
    label: 'Testnet3',
    labelKey: 'settingsNetwork.testnet3',
    descriptionKey: 'settingsNetwork.testnet3Description',
    color: '#f59e0b',
    ...TEST_NETWORK_KEYS,
  },
  [Network.TESTNET4]: {
    network: Network.TESTNET4,
    label: 'Testnet4',
    labelKey: 'settingsNetwork.testnet4',
    descriptionKey: 'settingsNetwork.testnet4Description',
    color: '#14b8a6',
    ...TEST_NETWORK_KEYS,
  },
  [Network.CHIPNET]: {
    network: Network.CHIPNET,
    label: 'Chipnet',
    labelKey: 'settingsNetwork.chipnet',
    descriptionKey: 'settingsNetwork.chipnetDescription',
    color: '#6366f1',
    ...TEST_NETWORK_KEYS,
  },
};

/** The networks a holder can pick, in the Rust network selector's order. */
export const SELECTABLE_NETWORKS: readonly Network[] = [
  Network.MAINNET,
  Network.TESTNET3,
  Network.TESTNET4,
  Network.CHIPNET,
];

export function networkProfile(network: Network): NetworkProfile {
  return NETWORK_PROFILES[network];
}

/**
 * A stored or wire network name, or `undefined` when it is not one. It never
 * guesses: callers decide what an unknown value means for them.
 */
export function parseNetwork(value: unknown): Network | undefined {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(NETWORK_PROFILES, value)
    ? (value as Network)
    : undefined;
}

export const cashAddressPrefix = (network: Network): CashAddressPrefix =>
  NETWORK_PROFILES[network].cashAddressPrefix;

export const isTestNetwork = (network: Network): boolean =>
  NETWORK_PROFILES[network].isTestnet;
