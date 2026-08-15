import { derivationPathToCashConnectPath } from '@cashconnect-js/nostr/wallet';
import { Network } from '../../state/slices/networkSlice';
import {
  derivePrivateKeyAtPath,
  getBchAccountPath,
} from '../HdWalletService';

export async function deriveCashConnectIdentityKey(args: {
  mnemonic: string;
  passphrase: string;
  network: Network;
  accountPath?: string;
}): Promise<Uint8Array> {
  const accountPath = getBchAccountPath(args.network, 0, args.accountPath);
  const cashConnectPath = derivationPathToCashConnectPath(accountPath);
  return derivePrivateKeyAtPath(
    args.mnemonic,
    args.passphrase,
    cashConnectPath
  );
}

export function expectedCashConnectPath(
  network: Network,
  accountPath?: string
): string {
  return derivationPathToCashConnectPath(
    getBchAccountPath(network, 0, accountPath)
  );
}
