import {
  decodeHdPublicKey,
  deriveHdPublicNodeChild,
  encodeHdPublicKey,
} from '@bitauth/libauth';

import { Network } from '../../../state/slices/networkSlice';
import {
  alignHdPublicKeyNetwork,
  deriveBchAddressFromHdPublicKey,
  getBchAccountPath,
  getHdKeyNetwork,
} from '../../../services/HdWalletService';

const HARDENED_INDEX = 0x80000000;
const MAX_XPUB_LENGTH = 256;

function accountPathHint(network: Network): string {
  return getBchAccountPath(network, 0).replace(/0'$/, "account'");
}

type PublicAddressPreview = {
  path: string;
  address: string;
  tokenAddress: string;
};

export type WatchOnlyAccountPreview = {
  accountPath: string;
  receive: PublicAddressPreview;
  change: PublicAddressPreview;
};

/**
 * Branch-level xPub for receive (0) or change (1).
 *
 * Exported because persisting a watch-only wallet derives a whole gap range per
 * branch, not just the preview's first address, and re-deriving the branch key
 * per address would repeat the validation on every call.
 */
export function watchOnlyBranchXpub(
  accountXpub: string,
  network: Network,
  branchIndex: 0 | 1
): string {
  return deriveBranchXpub(accountXpub, network, branchIndex);
}

function deriveBranchXpub(
  accountXpub: string,
  network: Network,
  branchIndex: 0 | 1
): string {
  // Align xpub/tpub version bytes to the wallet network (Trezor chipnet export
  // reopened on mainnet stores tpub while networkType is mainnet).
  const aligned = alignHdPublicKeyNetwork(network, accountXpub);
  const decoded = decodeHdPublicKey(aligned);
  if (typeof decoded === 'string') {
    throw new Error('Enter a valid BIP32 public key.');
  }
  if (decoded.network !== getHdKeyNetwork(network)) {
    throw new Error('The xPub network does not match the selected network.');
  }
  if (decoded.node.depth !== 3 || decoded.node.childIndex < HARDENED_INDEX) {
    throw new Error(
      `Use a hardened account xPub exported at ${accountPathHint(network)}.`
    );
  }

  const branch = deriveHdPublicNodeChild(decoded.node, branchIndex);
  if (typeof branch === 'string') {
    throw new Error('Could not derive the public wallet branch.');
  }
  const encoded = encodeHdPublicKey({ network: decoded.network, node: branch });
  if (typeof encoded === 'string') {
    throw new Error('Could not encode the public wallet branch.');
  }
  return encoded.hdPublicKey;
}

export function deriveWatchOnlyAccountPreview(
  network: Network,
  rawAccountXpub: string
): WatchOnlyAccountPreview {
  const trimmed = rawAccountXpub.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_XPUB_LENGTH) {
    throw new Error('Enter a valid BCH account xPub.');
  }

  // Same version-byte alignment as branch derivation — key material only.
  const accountXpub = alignHdPublicKeyNetwork(network, trimmed);
  const decoded = decodeHdPublicKey(accountXpub);
  if (typeof decoded === 'string') {
    throw new Error('Enter a valid BIP32 public key.');
  }
  if (decoded.network !== getHdKeyNetwork(network)) {
    throw new Error('The xPub network does not match the selected network.');
  }
  if (decoded.node.depth !== 3 || decoded.node.childIndex < HARDENED_INDEX) {
    throw new Error(
      `Use a hardened account xPub exported at ${accountPathHint(network)}.`
    );
  }

  const accountIndex = decoded.node.childIndex - HARDENED_INDEX;
  const accountPath = getBchAccountPath(network, accountIndex);
  const receiveXpub = deriveBranchXpub(accountXpub, network, 0);
  const changeXpub = deriveBranchXpub(accountXpub, network, 1);
  const receive = deriveBchAddressFromHdPublicKey(network, receiveXpub, 0n);
  const change = deriveBchAddressFromHdPublicKey(network, changeXpub, 0n);
  if (!receive || !change) {
    throw new Error('Could not derive BCH addresses from this xPub.');
  }

  return {
    accountPath,
    receive: {
      path: `${accountPath}/0/0`,
      address: receive.address,
      tokenAddress: receive.tokenAddress,
    },
    change: {
      path: `${accountPath}/1/0`,
      address: change.address,
      tokenAddress: change.tokenAddress,
    },
  };
}
