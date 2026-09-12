// Rebuilding the spending key for a coin received at this wallet's Cash Code.
//
// Every other coin the wallet spends has its key looked up from its address,
// because the address was derived at a known HD path and the keys table can be
// asked about it. An RPA payment lands somewhere that lookup cannot reach: a
// one-time P2PKH whose key is the wallet's spend key tweaked by an ECDH secret,
// where the secret depends on which outpoint the *sender* spent. Ask the keys
// table about that address and it has never heard of it.
//
// That single missing lookup is what made received RPA payments visible and
// unspendable. Detection worked, control was provable, the derivation existed
// and was covered by the live Chipnet test — but nothing rebuilt the key when a
// send actually selected one of these coins.
//
// The inputs are the coin's own `rpaOrigin`, which is public and already on
// chain, plus the wallet's RPA keys. No secret is stored anywhere: it is
// recomputed here and discarded with the rest of the send.

import { hexToBin } from '@bitauth/libauth';
import { Network } from '../state/slices/networkSlice';
import type { UTXO } from '../types/types';
import {
  getBchAccountPath,
  normalizeBchAccountPath,
} from './HdWalletService';
import {
  computeSharedSecret,
  deriveRpaKeys,
  deriveSpendingKey,
} from './RpaService';

/**
 * The unlocked wallet's seed material and account path.
 *
 * Mirrors WalletSpecialActivityService's own context helper rather than
 * exporting it: both need the same four values, and the scan side asking for
 * them does not make the spend side its dependant.
 */
async function rpaWalletContext(walletId: number): Promise<{
  mnemonic: string;
  passphrase: string;
  network: Network;
  accountPath: string;
}> {
  const { default: WalletManager } = await import(
    '../apis/WalletManager/WalletManager'
  );
  const info = await WalletManager().getWalletInfo(walletId);
  if (!info?.mnemonic) {
    throw new Error('Wallet is not unlocked, so this coin cannot be signed.');
  }
  const network =
    info.networkType === Network.CHIPNET ? Network.CHIPNET : Network.MAINNET;
  return {
    mnemonic: info.mnemonic,
    passphrase: info.passphrase ?? '',
    network,
    accountPath: normalizeBchAccountPath(
      info.derivation_path || getBchAccountPath(network)
    ),
  };
}

/**
 * The private key that spends `utxo`, or `null` when it is not an RPA coin.
 *
 * Returning `null` rather than throwing keeps the caller's shape: an ordinary
 * coin falls through to the address lookup exactly as before.
 *
 * Takes a wallet id rather than a mnemonic so the only callers that handle
 * seed material stay the ones that already do. An unlocked wallet is required
 * for the same reason spending anything else is.
 */
export async function deriveRpaUtxoSigningKey(
  utxo: Pick<UTXO, 'rpaOrigin'>,
  walletId: number
): Promise<Uint8Array | null> {
  const origin = utxo.rpaOrigin;
  if (!origin) return null;

  const { mnemonic, passphrase, network, accountPath } =
    await rpaWalletContext(walletId);
  const keys = await deriveRpaKeys(mnemonic, passphrase, network, accountPath);
  try {
    // The same ECDH the scan performed when it detected this payment, redone
    // from the origin the coin carried rather than from a stored secret.
    const secret = computeSharedSecret(
      keys.scanPrivkey,
      hexToBin(origin.senderPubkey),
      origin.prevoutTxid,
      origin.prevoutIndex
    );
    try {
      return await deriveSpendingKey(keys.spendPrivkey, secret, 0);
    } finally {
      secret.fill(0);
    }
  } finally {
    // deriveRpaKeys hands back copies; erase them rather than leaving two more
    // private keys alive for the rest of the send.
    keys.scanPrivkey.fill(0);
    keys.spendPrivkey.fill(0);
  }
}
