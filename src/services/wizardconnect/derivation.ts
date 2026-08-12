import { DerivationPath } from '@wizardconnect/wallet';
import { Network } from '../../redux/networkSlice';
import {
  createDeterministicRuntimePrivateKey,
  derivePrivateKeyAtPath,
  derivePublicKeyFromHdPublicKey,
  getBchBranchPath,
} from '../HdWalletService';

const ACCOUNT_INDEX = 0;

export function derivationPathToHdPath(path: DerivationPath, network: Network): string {
  switch (path) {
    case DerivationPath.Receive:
      return getBchBranchPath(network, ACCOUNT_INDEX, 0);
    case DerivationPath.Change:
      return getBchBranchPath(network, ACCOUNT_INDEX, 1);
    case DerivationPath.Cauldron:
      return getBchBranchPath(network, ACCOUNT_INDEX, 7);
    default:
      throw new Error(`Unsupported derivation path: ${String(path)}`);
  }
}

export async function derivePrivateKeyForPath(
  mnemonic: string,
  passphrase: string,
  network: Network,
  path: DerivationPath,
  index: bigint
): Promise<Uint8Array> {
  return derivePrivateKeyAtPath(
    mnemonic,
    passphrase,
    `${derivationPathToHdPath(path, network)}/${index.toString()}`
  );
}

export function derivePublicKeyFromXpub(xpub: string, index: bigint): Uint8Array {
  return derivePublicKeyFromHdPublicKey(xpub, index);
}

export function createDeterministicRuntimeRelayKey(
  uri: string,
  walletId: number
): Uint8Array {
  return createDeterministicRuntimePrivateKey(
    'wizardconnect',
    String(walletId),
    uri
  );
}
