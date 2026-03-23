import {
  binToHex,
  hash256,
  hexToBin,
} from '@bitauth/libauth';

import { ensureUint8Array, parseSatoshis } from '../../utils/binary';
import type {
  CauldronPool,
  CauldronPoolParameters,
  CauldronPoolUtxoCandidate,
  ParsedCauldronUnlockingBytecode,
} from './types';

const OP_HASH256 = 0xaa;
const OP_EQUAL = 0x87;

const POOL_V0_PRE_PUBKEY_BIN = hexToBin('44746376a914');
const POOL_V0_PUBKEY_SIZE = 20;
const POOL_V0_POST_PUBKEY_BIN = hexToBin(
  '88ac67c0d1c0ce88c25288c0cdc0c788c0c6c0d095c0c6c0cc9490539502e80396c0cc7c94c0d3957ca268'
);
const POOL_V0_REDEEMSCRIPT_SIZE =
  POOL_V0_PRE_PUBKEY_BIN.length -
  1 +
  POOL_V0_PUBKEY_SIZE +
  POOL_V0_POST_PUBKEY_BIN.length;
const POOL_V0_UNLOCKING_SIZE =
  POOL_V0_PRE_PUBKEY_BIN.length +
  POOL_V0_PUBKEY_SIZE +
  POOL_V0_POST_PUBKEY_BIN.length;

function assertWithdrawPublicKeyHash(
  withdrawPublicKeyHash: Uint8Array
): asserts withdrawPublicKeyHash is Uint8Array {
  if (withdrawPublicKeyHash.length !== POOL_V0_PUBKEY_SIZE) {
    throw new Error('Cauldron withdraw public key hash must be 20 bytes');
  }
}

export function buildCauldronPoolV0RedeemScript(
  parameters: CauldronPoolParameters
): Uint8Array {
  const withdrawPublicKeyHash = ensureUint8Array(parameters.withdrawPublicKeyHash);
  assertWithdrawPublicKeyHash(withdrawPublicKeyHash);

  return Uint8Array.from([
    ...POOL_V0_PRE_PUBKEY_BIN.slice(1),
    ...withdrawPublicKeyHash,
    ...POOL_V0_POST_PUBKEY_BIN,
  ]);
}

export function buildCauldronPoolV0ExchangeUnlockingBytecode(
  parameters: CauldronPoolParameters
): Uint8Array {
  const withdrawPublicKeyHash = ensureUint8Array(parameters.withdrawPublicKeyHash);
  assertWithdrawPublicKeyHash(withdrawPublicKeyHash);

  return Uint8Array.from([
    ...POOL_V0_PRE_PUBKEY_BIN,
    ...withdrawPublicKeyHash,
    ...POOL_V0_POST_PUBKEY_BIN,
  ]);
}

export function getCauldronPoolV0WithdrawPublicKeyHash(
  redeemScript: Uint8Array
): Uint8Array | null {
  if (redeemScript.length !== POOL_V0_REDEEMSCRIPT_SIZE) return null;

  const pre = POOL_V0_PRE_PUBKEY_BIN.slice(1);
  if (
    binToHex(redeemScript.slice(0, pre.length)) !== binToHex(pre) ||
    binToHex(redeemScript.slice(pre.length + POOL_V0_PUBKEY_SIZE)) !==
      binToHex(POOL_V0_POST_PUBKEY_BIN)
  ) {
    return null;
  }

  return redeemScript.slice(pre.length, pre.length + POOL_V0_PUBKEY_SIZE);
}

export function extractCauldronPoolV0ParametersFromUnlockingBytecode(
  unlockingBytecode: Uint8Array
): ParsedCauldronUnlockingBytecode | null {
  if (unlockingBytecode.length < POOL_V0_UNLOCKING_SIZE) return null;

  const offset = unlockingBytecode.length - POOL_V0_UNLOCKING_SIZE;
  const pre = unlockingBytecode.slice(offset, offset + POOL_V0_PRE_PUBKEY_BIN.length);
  const post = unlockingBytecode.slice(
    offset + POOL_V0_PRE_PUBKEY_BIN.length + POOL_V0_PUBKEY_SIZE
  );

  if (
    binToHex(pre) !== binToHex(POOL_V0_PRE_PUBKEY_BIN) ||
    binToHex(post) !== binToHex(POOL_V0_POST_PUBKEY_BIN)
  ) {
    return null;
  }

  return {
    parameters: {
      withdrawPublicKeyHash: unlockingBytecode.slice(
        offset + POOL_V0_PRE_PUBKEY_BIN.length,
        offset + POOL_V0_PRE_PUBKEY_BIN.length + POOL_V0_PUBKEY_SIZE
      ),
    },
    kind: offset === 0 ? 'trade' : 'withdraw',
  };
}

export function buildCauldronPoolV0LockingBytecode(
  parameters: CauldronPoolParameters
): Uint8Array {
  const redeemScript = buildCauldronPoolV0RedeemScript(parameters);
  const payload = hash256(redeemScript);
  return Uint8Array.from([OP_HASH256, payload.length, ...payload, OP_EQUAL]);
}

export function isCauldronPoolV0LockingBytecode(
  lockingBytecode: Uint8Array,
  parameters: CauldronPoolParameters
): boolean {
  return (
    binToHex(lockingBytecode) ===
    binToHex(buildCauldronPoolV0LockingBytecode(parameters))
  );
}

export function tryParseCauldronPoolFromUtxo(
  candidate: CauldronPoolUtxoCandidate,
  parameters: CauldronPoolParameters
): CauldronPool | null {
  const lockingBytecode = ensureUint8Array(candidate.lockingBytecode);
  if (!isCauldronPoolV0LockingBytecode(lockingBytecode, parameters)) {
    return null;
  }

  const category = String(candidate.token?.category ?? '').trim();
  if (!category) return null;

  const tokenAmount = parseSatoshis(candidate.token?.amount);
  if (tokenAmount <= 0n) return null;

  return {
    version: '0',
    parameters,
    txHash: candidate.tx_hash,
    outputIndex: candidate.tx_pos,
    output: {
      amountSatoshis: parseSatoshis(candidate.amount ?? candidate.value),
      tokenCategory: category,
      tokenAmount,
      lockingBytecode,
    },
  };
}
