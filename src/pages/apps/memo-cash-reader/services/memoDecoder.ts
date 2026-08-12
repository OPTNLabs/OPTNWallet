import {
  binToHex,
  hexToBin,
  lockingBytecodeToCashAddress,
  ripemd160,
  sha256,
} from '@bitauth/libauth';
import {
  bytesToHex,
  decodeUtf8,
  parseOpReturnPushes,
  parseUnlockingPushes,
  reverseHexBytes,
  stripHexPrefix,
} from './opReturn';

export const MEMO_ACTION_CODES = {
  set_name: '6d01',
  post: '6d02',
  reply: '6d03',
  like_tip: '6d04',
  set_profile_text: '6d05',
  follow: '6d06',
  unfollow: '6d07',
  set_profile_picture: '6d0a',
  post_topic: '6d0c',
} as const;

export type MemoAction =
  | { type: 'post'; message: string }
  | { type: 'reply'; txid: string; txidAlt?: string; message: string }
  | { type: 'set_name'; name: string }
  | { type: 'set_profile_text'; text: string }
  | { type: 'set_profile_picture'; url: string }
  | { type: 'follow'; address: string }
  | { type: 'unfollow'; address: string }
  | { type: 'like_tip'; txid: string; txidAlt?: string }
  | { type: 'post_topic'; topic: string; message: string };

export type DecodedMemoRow = {
  id: string;
  txid: string;
  outputIndex: number;
  internalId: bigint;
  action: MemoAction;
  actorAddress: string | null;
};

const ACTION_CODE_SET = new Set<string>(Object.values(MEMO_ACTION_CODES));

function toCashaddrPrefix(network: string | null | undefined) {
  const v = String(network ?? '').toLowerCase();
  return v === 'chipnet' || v === 'testnet' || v === 'regtest'
    ? 'bchtest'
    : 'bitcoincash';
}

export function deriveAddressFromLockingBytecode(
  lockingBytecodeHex: string | null | undefined,
  network: string | null | undefined
): string | null {
  const hex = stripHexPrefix(String(lockingBytecodeHex ?? ''));
  if (!hex) return null;

  const result = lockingBytecodeToCashAddress({
    bytecode: hexToBin(hex),
    prefix: toCashaddrPrefix(network),
  });

  if (typeof result === 'string') return null;
  return result.address;
}

function hexToTextField(pushes: Uint8Array[], index: number): string {
  const data = pushes[index];
  if (!data) return '';
  return decodeUtf8(data).trim();
}

function hexToTxidField(pushes: Uint8Array[], index: number) {
  const data = pushes[index];
  if (!data || data.length !== 32) return { txid: '', txidAlt: '' };
  const txid = bytesToHex(data);
  const txidAlt = reverseHexBytes(txid);
  return { txid, txidAlt };
}

function decodeFollowAddress(pushes: Uint8Array[], index: number): string {
  const data = pushes[index];
  if (!data) return '';

  const asText = decodeUtf8(data).trim();
  if (asText.includes(':')) return asText;

  // Many memo clients store hash160 payload (20 bytes) for follow ops.
  if (data.length === 20) {
    const lock = `76a914${bytesToHex(data)}88ac`;
    const out = lockingBytecodeToCashAddress({
      bytecode: hexToBin(lock),
      prefix: 'bitcoincash',
    });
    if (typeof out !== 'string') return out.address;
  }

  return asText || bytesToHex(data);
}

export function decodeMemoActionFromLockingBytecode(
  lockingBytecodeHex: string
): MemoAction | null {
  const pushes = parseOpReturnPushes(lockingBytecodeHex);
  if (pushes.length === 0) return null;

  const actionCode = binToHex(pushes[0]).toLowerCase();
  if (!ACTION_CODE_SET.has(actionCode)) {
    return null;
  }

  switch (actionCode) {
    case MEMO_ACTION_CODES.post: {
      return { type: 'post', message: hexToTextField(pushes, 1) };
    }
    case MEMO_ACTION_CODES.reply: {
      const { txid, txidAlt } = hexToTxidField(pushes, 1);
      return {
        type: 'reply',
        txid,
        txidAlt: txidAlt || undefined,
        message: hexToTextField(pushes, 2),
      };
    }
    case MEMO_ACTION_CODES.set_name: {
      return { type: 'set_name', name: hexToTextField(pushes, 1) };
    }
    case MEMO_ACTION_CODES.set_profile_text: {
      return { type: 'set_profile_text', text: hexToTextField(pushes, 1) };
    }
    case MEMO_ACTION_CODES.set_profile_picture: {
      return { type: 'set_profile_picture', url: hexToTextField(pushes, 1) };
    }
    case MEMO_ACTION_CODES.follow: {
      return { type: 'follow', address: decodeFollowAddress(pushes, 1) };
    }
    case MEMO_ACTION_CODES.unfollow: {
      return { type: 'unfollow', address: decodeFollowAddress(pushes, 1) };
    }
    case MEMO_ACTION_CODES.like_tip: {
      const { txid, txidAlt } = hexToTxidField(pushes, 1);
      return { type: 'like_tip', txid, txidAlt: txidAlt || undefined };
    }
    case MEMO_ACTION_CODES.post_topic: {
      return {
        type: 'post_topic',
        topic: hexToTextField(pushes, 1),
        message: hexToTextField(pushes, 2),
      };
    }
    default:
      return null;
  }
}

export function deriveAddressFromUnlockingBytecode(
  unlockingBytecodeHex: string | null | undefined,
  network: string | null | undefined
): string | null {
  const hex = stripHexPrefix(String(unlockingBytecodeHex ?? ''));
  if (!hex) return null;

  let pushes: Uint8Array[];
  try {
    pushes = parseUnlockingPushes(hex);
  } catch {
    return null;
  }
  if (pushes.length === 0) return null;

  // For standard P2PKH unlockers, the final push is compressed/uncompressed pubkey.
  const pubkey = pushes[pushes.length - 1];
  if (!(pubkey.length === 33 || pubkey.length === 65)) return null;

  const pkh = ripemd160.hash(sha256.hash(pubkey));
  const lockHex = `76a914${bytesToHex(pkh)}88ac`;
  const result = lockingBytecodeToCashAddress({
    bytecode: hexToBin(lockHex),
    prefix: toCashaddrPrefix(network),
  });
  if (typeof result === 'string') return null;
  return result.address;
}
