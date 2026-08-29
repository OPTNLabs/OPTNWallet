// What each level of key access can do.
//
// The spec makes this a requirement rather than a nicety (REQ-5): "The receiver
// must be able to separate the keys used to generate and detect addresses from
// the keys used to spend (which can be offline), so to separate the privacy and
// security aspects."
//
// That gives three tiers, and the interesting property is what each one CANNOT
// do:
//
//   publish  branch-3 xpub only          -> can emit a cashcode
//                                        -> cannot detect: ECDH needs scanPrivkey
//   detect   scanPrivkey + spendPubkey   -> can find and value payments
//                                        -> cannot spend: no spendPrivkey
//   spend    + spendPrivkey              -> controls the coin
//
// The middle tier is the one worth guarding. `matchRpaPaymentsInRawTx` takes
// `Pick<RpaKeys, 'scanPrivkey' | 'spendPubkey'>`, which is what lets a hot
// scanner watch a wallet whose spending key never leaves cold storage. Widening
// that parameter to the full RpaKeys would compile, pass every other test, and
// quietly destroy the property — so it is asserted here with a value that
// genuinely has no spend key in it.
import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import {
  cashAddressToLockingBytecode,
  encodeTransaction,
  generatePrivateKey,
  hexToBin,
  secp256k1,
  type TransactionCommon,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { Network } from '../../state/slices/networkSlice';
import {
  computeSharedSecret,
  derivePaymentAddress,
  deriveRpaGateXpub,
  deriveRpaKeys,
  deriveSpendingKey,
  encodePaycode,
} from '../RpaService';
import { matchRpaPaymentsInRawTx } from '../RpaDetect';

const PAID_SATS = 5_000;

/** A transaction from a sender who paid `code`, spending one P2PKH input. */
function senderTransaction(
  senderPubkey: Uint8Array,
  stealthAddress: string,
  prevTxid: string
): string {
  const lock = cashAddressToLockingBytecode(stealthAddress);
  if (typeof lock === 'string') throw new Error(lock);
  const tx: TransactionCommon = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: hexToBin(prevTxid),
        outpointIndex: 0,
        sequenceNumber: 0xffffffff,
        // P2PKH scriptSig: <sig> <pubkey>. Only the pubkey push matters here.
        unlockingBytecode: Uint8Array.from([
          0x41,
          ...new Uint8Array(65),
          0x21,
          ...senderPubkey,
        ]),
      },
    ],
    outputs: [
      { lockingBytecode: lock.bytecode, valueSatoshis: BigInt(PAID_SATS) },
    ],
  };
  return Buffer.from(encodeTransaction(tx)).toString('hex');
}

describe('RPA capability tiers', () => {
  it('publishes from an xpub, detects without a spend key, spends only with one', async () => {
    const mnemonic = bip39.generateMnemonic();
    const keys = await deriveRpaKeys(mnemonic, '', Network.CHIPNET);

    // ── Tier 1: publish ──────────────────────────────────────────────────────
    // Branch 3 is a sibling of receive(0)/change(1), and CKD_pub only walks
    // downward, so this xpub yields the scan and spend pubkeys and nothing
    // above them.
    const gate = await deriveRpaGateXpub(mnemonic, '', Network.CHIPNET);
    expect(gate.rpaPath).toMatch(/\/3$/);
    const code = encodePaycode(
      keys.scanPubkey,
      keys.spendPubkey,
      Network.CHIPNET,
      8
    );
    expect(code.startsWith('cashcodetest:')).toBe(true);

    // A sender pays that code.
    const senderPrivkey = generatePrivateKey(() =>
      crypto.getRandomValues(new Uint8Array(32))
    );
    const senderPubkey = secp256k1.derivePublicKeyCompressed(senderPrivkey);
    if (typeof senderPubkey === 'string') throw new Error(senderPubkey);
    const prevTxid = 'ab'.repeat(32);
    const secret = computeSharedSecret(
      senderPrivkey,
      keys.scanPubkey,
      prevTxid,
      0
    );
    const stealthAddress = derivePaymentAddress(
      keys.spendPubkey,
      secret,
      Network.CHIPNET,
      0
    );
    const rawTx = senderTransaction(
      Uint8Array.from(senderPubkey),
      stealthAddress,
      prevTxid
    );

    // ── Tier 2: detect, with no spend key anywhere in scope ──────────────────
    const watchOnly: { scanPrivkey: Uint8Array; spendPubkey: Uint8Array } = {
      scanPrivkey: keys.scanPrivkey,
      spendPubkey: keys.spendPubkey,
    };
    expect(Object.keys(watchOnly).sort()).toEqual(['scanPrivkey', 'spendPubkey']);

    const matches = matchRpaPaymentsInRawTx(rawTx, watchOnly, Network.CHIPNET);
    expect(matches).toHaveLength(1);
    expect(matches[0].address).toBe(stealthAddress);
    expect(matches[0].valueSats).toBe(PAID_SATS);

    // ── Tier 3: spend ────────────────────────────────────────────────────────
    const received = computeSharedSecret(
      keys.scanPrivkey,
      Uint8Array.from(senderPubkey),
      matches[0].prevoutHash,
      matches[0].prevoutIndex
    );
    const spendingKey = await deriveSpendingKey(keys.spendPrivkey, received, 0);
    const spendingPubkey = secp256k1.derivePublicKeyCompressed(spendingKey);
    if (typeof spendingPubkey === 'string') throw new Error(spendingPubkey);

    // The key derived from the spend PRIVATE key controls the address the
    // sender paid. Tier 2 could see that coin; only tier 3 can move it.
    const lock = cashAddressToLockingBytecode(matches[0].address);
    if (typeof lock === 'string') throw new Error(lock);
    expect(Buffer.from(lock.bytecode.slice(3, 23)).toString('hex')).toBe(
      Buffer.from(hash160(Uint8Array.from(spendingPubkey))).toString('hex')
    );
  });

  it('cannot detect a payment without the scan private key', async () => {
    // The tier-1 boundary: publishing is not watching. A holder of the xpub can
    // hand out a code and still learn nothing about who paid it.
    const keys = await deriveRpaKeys(bip39.generateMnemonic(), '', Network.CHIPNET);
    const stranger = await deriveRpaKeys(bip39.generateMnemonic(), '', Network.CHIPNET);

    const senderPrivkey = generatePrivateKey(() =>
      crypto.getRandomValues(new Uint8Array(32))
    );
    const senderPubkey = secp256k1.derivePublicKeyCompressed(senderPrivkey);
    if (typeof senderPubkey === 'string') throw new Error(senderPubkey);
    const prevTxid = 'cd'.repeat(32);
    const secret = computeSharedSecret(senderPrivkey, keys.scanPubkey, prevTxid, 0);
    const rawTx = senderTransaction(
      Uint8Array.from(senderPubkey),
      derivePaymentAddress(keys.spendPubkey, secret, Network.CHIPNET, 0),
      prevTxid
    );

    // Right spend pubkey, wrong scan private key: nothing is found.
    expect(
      matchRpaPaymentsInRawTx(
        rawTx,
        { scanPrivkey: stranger.scanPrivkey, spendPubkey: keys.spendPubkey },
        Network.CHIPNET
      )
    ).toEqual([]);
  });
});
