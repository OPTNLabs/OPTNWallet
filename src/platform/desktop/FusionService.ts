// Wallet-owned key and fresh-output preparation shared by the authoritative
// server Fusion runner. Network execution deliberately lives elsewhere so no
// caller can bypass its reservation, Tor relay, or completion safeguards.

import { cashAddressToLockingBytecode } from '@bitauth/libauth';

import KeyService from '../../services/KeyService';
import { Network } from '../../state/slices/networkSlice';
import type { UTXO } from '../../types/types';
import { binToHex } from '../../utils/hex';

interface FusionRunInput {
  prev_txid: string;
  prev_index: number;
  pubkey: string;
  value: number;
  privkey: string;
}

export interface FusionOutcome {
  ok: boolean;
  broadcast_verified: boolean;
  txid: string | null;
  tx_hex: string | null;
  message: string;
}

/**
 * Build the signed-input list from selected UTXOs. Private keys cross only the
 * local Tauri IPC boundary and are consumed by the native signer.
 */
export async function gatherInputs(
  walletId: number,
  utxos: UTXO[]
): Promise<FusionRunInput[]> {
  const keys = await KeyService.retrieveKeys(walletId);
  const byAddress = new Map(keys.map((key) => [key.address, key.publicKey]));

  const inputs: FusionRunInput[] = [];
  for (const utxo of utxos) {
    const publicKey = byAddress.get(utxo.address);
    if (!publicKey) {
      throw new Error(`No key for UTXO address ${utxo.address}`);
    }
    // 'background': auto-fusion runs unattended and a prompt mid-round would
    // kill it. The user consented when they enabled fusion.
    const privateKey = await KeyService.fetchAddressPrivateKey(
      utxo.address,
      'background'
    );
    if (!privateKey) {
      throw new Error(`No private key for ${utxo.address}`);
    }
    inputs.push({
      prev_txid: utxo.tx_hash,
      prev_index: utxo.tx_pos,
      pubkey: binToHex(publicKey),
      value: utxo.value ?? Number(utxo.amount ?? 0),
      privkey: binToHex(privateKey),
    });
  }
  return inputs;
}

function scriptForAddress(address: string): string {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') {
    throw new Error(`bad address ${address}`);
  }
  return binToHex(decoded.bytecode);
}

/**
 * Persist fresh receive indexes before their scripts leave the wallet. Failed
 * rounds intentionally do not recycle these addresses after peer disclosure.
 */
export async function createFreshFusionOutputScripts(
  walletId: number,
  network: Network,
  count: number
): Promise<string[]> {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) {
    throw new Error('invalid wallet id for Fusion outputs');
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new Error('invalid Fusion output count');
  }

  const existing = (await KeyService.retrieveKeys(walletId)).filter(
    (key) => Number(key.accountIndex) === 0 && Number(key.changeIndex) === 0
  );
  const startIndex = existing.reduce(
    (maximum, key) => Math.max(maximum, Number(key.addressIndex) + 1),
    0
  );

  for (let offset = 0; offset < count; offset += 1) {
    await KeyService.createKeys(walletId, 0, 0, startIndex + offset);
  }

  const persisted = await KeyService.retrieveKeys(walletId);
  const expectedPrefix =
    network === Network.MAINNET ? 'bitcoincash:' : 'bchtest:';
  return Array.from({ length: count }, (_, offset) => {
    const addressIndex = startIndex + offset;
    const key = persisted.find(
      (candidate) =>
        Number(candidate.accountIndex) === 0 &&
        Number(candidate.changeIndex) === 0 &&
        Number(candidate.addressIndex) === addressIndex
    );
    if (!key) {
      throw new Error(`Fusion output key ${addressIndex} was not persisted.`);
    }
    if (!key.address.toLowerCase().startsWith(expectedPrefix)) {
      throw new Error(
        'Fusion output key network does not match the active wallet.'
      );
    }
    return scriptForAddress(key.address);
  });
}
