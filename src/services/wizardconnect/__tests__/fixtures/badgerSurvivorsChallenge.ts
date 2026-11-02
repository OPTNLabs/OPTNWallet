/**
 * Vendored from LifestoneLabs/BadgerSurvivors shared/editor/challengeTx.js
 * and shared/editor/editorChallenge.js at master 775af984 (v0.545), ported to
 * TypeScript with libauth imported directly. Test-only: it stands in for the
 * Badger Survivors server so OPTN's proof can be checked against the real
 * verifier logic. Keep in sync with upstream if the challenge shape changes.
 */
import {
  binToHex,
  decodeAuthenticationInstructions,
  decodeCashAddress,
  decodeTransaction,
  hash160,
  hexToBin,
  sha256,
  utf8ToBin,
  type AuthenticationInstruction,
  type Transaction,
} from '@bitauth/libauth';

export const CHALLENGE_OUTPOINT_TAG = 'BadgerSurvivors editor challenge:';
export const CHALLENGE_OP_RETURN_TAG = 'BSEDITOR';
export const CHALLENGE_VALUE_SATS = 1000n;
export const CHALLENGE_SIGHASH_TYPES = new Set([0x41, 0x61]);

/**
 * Golden bytes produced by running upstream buildChallengeTx (unmodified JS)
 * for the throwaway test key 0x00..07, nonce 0123456789abcdef0123456789abcdef.
 */
export const BS_GOLDEN = {
  privateKeyByte: 7,
  address: 'bitcoincash:qpw7m7leafvem48ref4gpvenc3e06zeldy70v28d52',
  publicKey:
    '025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc',
  nonce: '0123456789abcdef0123456789abcdef',
  lockingBytecode: '76a9145dedfbf9ea599dd4e3ca6a80b333c472fd0b3f6988ac',
  outpointHash:
    '35433d7c83af2289ea6cd6906dffc3403f9b26542371a58d84990239c0a154a8',
  unsignedHex:
    '0200000001a854a1c0390299848da5712354269b3f40c3ff6d90d66cea8922af837c3d43350000000000ffffffff0200000000000000002b6a084253454449544f52203031323334353637383961626364656630313233343536373839616263646566e8030000000000001976a9145dedfbf9ea599dd4e3ca6a80b333c472fd0b3f6988ac00000000',
} as const;

function p2pkhLocking(payload: Uint8Array): Uint8Array {
  return Uint8Array.from([0x76, 0xa9, 0x14, ...payload, 0x88, 0xac]);
}

function pushBytes(bytes: Uint8Array): number[] {
  if (bytes.length > 75) throw new Error('push too long');
  return [bytes.length, ...bytes];
}

function sameBytes(a?: Uint8Array, b?: Uint8Array): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function buildChallengeTx(nonce: string, address: string) {
  if (!/^[0-9a-f]{32}$/.test(nonce)) return null;
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string' || decoded.payload.length !== 20) return null;
  const lockingBytecode = p2pkhLocking(decoded.payload);
  const input = {
    outpointTransactionHash: sha256.hash(
      utf8ToBin(`${CHALLENGE_OUTPOINT_TAG}${nonce}`)
    ),
    outpointIndex: 0,
    sequenceNumber: 0xffffffff,
    unlockingBytecode: new Uint8Array(0),
  };
  const outputs = [
    {
      lockingBytecode: Uint8Array.from([
        0x6a,
        ...pushBytes(utf8ToBin(CHALLENGE_OP_RETURN_TAG)),
        ...pushBytes(utf8ToBin(nonce)),
      ]),
      valueSatoshis: 0n,
    },
    { lockingBytecode, valueSatoshis: CHALLENGE_VALUE_SATS },
  ];
  const sourceOutput = {
    ...input,
    valueSatoshis: CHALLENGE_VALUE_SATS,
    lockingBytecode,
  };
  return {
    inputs: [sourceOutput],
    outputs,
    sourceOutputs: [sourceOutput],
    version: 2,
    locktime: 0,
    hash: binToHex(decoded.payload),
  };
}

type Vm = {
  verify: (program: {
    transaction: Transaction;
    sourceOutputs: unknown[];
  }) => string | true;
};

export function verifyChallengeTx(
  vm: Vm,
  {
    signedTransaction,
    nonce,
    address,
  }: { signedTransaction: string; nonce: string; address: string }
): { ok: true } | { ok: false; reason: string } {
  const expected = buildChallengeTx(nonce, address);
  if (!expected) return { ok: false, reason: 'bad_challenge' };
  if (
    !/^[0-9a-fA-F]+$/.test(signedTransaction) ||
    signedTransaction.length > 4000
  ) {
    return { ok: false, reason: 'bad_transaction' };
  }
  const tx = decodeTransaction(hexToBin(signedTransaction));
  if (typeof tx === 'string') return { ok: false, reason: 'bad_transaction' };
  if (tx.inputs.length !== 1 || tx.outputs.length !== 2) {
    return { ok: false, reason: 'bad_transaction' };
  }
  const [input] = tx.inputs;
  if (
    !sameBytes(
      input.outpointTransactionHash,
      expected.sourceOutputs[0].outpointTransactionHash
    ) ||
    input.outpointIndex !== 0
  ) {
    return { ok: false, reason: 'bad_transaction' };
  }
  for (let i = 0; i < 2; i += 1) {
    if (
      !sameBytes(
        tx.outputs[i].lockingBytecode,
        expected.outputs[i].lockingBytecode
      ) ||
      tx.outputs[i].valueSatoshis !== expected.outputs[i].valueSatoshis ||
      tx.outputs[i].token
    ) {
      return { ok: false, reason: 'bad_transaction' };
    }
  }
  const ops = decodeAuthenticationInstructions(
    input.unlockingBytecode
  ) as (AuthenticationInstruction & {
    data?: Uint8Array;
  })[];
  if (ops.length !== 2 || !ops[0].data || !ops[1].data) {
    return { ok: false, reason: 'unsigned' };
  }
  const [sig, pubkey] = [ops[0].data, ops[1].data];
  if (sig.length < 9 || !CHALLENGE_SIGHASH_TYPES.has(sig[sig.length - 1])) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (binToHex(hash160(pubkey)) !== expected.hash) {
    return { ok: false, reason: 'wrong_key' };
  }
  const sourceOutputs = expected.sourceOutputs.map((so) => ({
    ...so,
    unlockingBytecode: input.unlockingBytecode,
  }));
  let result: string | true;
  try {
    result = vm.verify({ transaction: tx, sourceOutputs });
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  return result === true
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}
