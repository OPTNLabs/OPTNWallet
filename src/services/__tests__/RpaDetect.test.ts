import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import {
  encodeTransaction,
  generatePrivateKey,
  hexToBin,
  secp256k1,
  type TransactionCommon,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { encodeCashAddress } from '@bitauth/libauth';
import { Network } from '../../state/slices/networkSlice';
import { deriveRpaKeys, encodePaycode } from '../RpaService';
import { finalizeRpaPayment } from '../RpaSender';
import { matchRpaPaymentsInRawTx, normalizeRpaTxid } from '../RpaDetect';

const MNEMONIC = bip39.generateMnemonic();

function p2pkhLock(pubkey: Uint8Array): Uint8Array {
  return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160(pubkey), 0x88, 0xac]);
}

function addressOf(pubkey: Uint8Array, network: Network): string {
  const encoded = encodeCashAddress({
    prefix: network === Network.MAINNET ? 'bitcoincash' : 'bchtest',
    type: 'p2pkh',
    payload: hash160(pubkey),
  });
  if (typeof encoded === 'string') throw new Error(encoded);
  return encoded.address;
}

describe('RpaDetect', () => {
  it('normalizes a 64-char txid and rejects junk', () => {
    expect(normalizeRpaTxid(`  ${'AB'.repeat(32)}  `)).toBe('ab'.repeat(32));
    expect(normalizeRpaTxid('not-a-txid')).toBeNull();
    expect(normalizeRpaTxid('ab'.repeat(31))).toBeNull();
  });

  it('finds the stealth output in a sender-built paycode transaction', async () => {
    const recipient = await deriveRpaKeys(MNEMONIC, '', Network.CHIPNET);
    const senderPriv = generatePrivateKey(() =>
      crypto.getRandomValues(new Uint8Array(32))
    );
    const senderPub = secp256k1.derivePublicKeyCompressed(senderPriv);
    if (typeof senderPub === 'string') throw new Error(senderPub);
    const senderAddress = addressOf(senderPub, Network.CHIPNET);

    const dummyPriv = generatePrivateKey(() =>
      crypto.getRandomValues(new Uint8Array(32))
    );
    const dummyPub = secp256k1.derivePublicKeyCompressed(dummyPriv);
    if (typeof dummyPub === 'string') throw new Error(dummyPub);
    const dummyAddress = addressOf(dummyPub, Network.CHIPNET);

    // Non-palindromic, so a byte-order mistake cannot pass unnoticed.
    //
    // No reversal here: libauth's `outpointTransactionHash` is the display
    // (big-endian) txid, and encodeTransaction writes the little-endian wire
    // form itself. Pre-reversing produces a transaction whose wire outpoint is
    // display order, which a node rejects with "Missing inputs" -- and it was
    // this fixture that the scanner's old try-both-byte-orders branch existed
    // to accommodate.
    const prevTxid =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const tx: TransactionCommon = {
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointTransactionHash: hexToBin(prevTxid),
          outpointIndex: 0,
          sequenceNumber: 0xfffffffe,
          unlockingBytecode: Uint8Array.of(),
        },
      ],
      outputs: [
        {
          lockingBytecode: p2pkhLock(dummyPub),
          valueSatoshis: 10_000n,
        },
        {
          lockingBytecode: p2pkhLock(senderPub),
          valueSatoshis: 50_000n,
        },
      ],
    };

    const result = await finalizeRpaPayment({
      rawTxHex: Buffer.from(encodeTransaction(tx)).toString('hex'),
      dummyAddress,
      paycode: {
        version: 0x05,
        prefixBits: 8,
        scanPubkey: recipient.scanPubkey,
        spendPubkey: recipient.spendPubkey,
        expiry: 0,
      },
      utxos: [
        {
          address: senderAddress,
          height: 1,
          tx_hash: prevTxid,
          tx_pos: 0,
          value: 61_000,
          amount: 61_000,
        },
      ],
      inputKeys: [{ priv: senderPriv, pub: Uint8Array.from(senderPub) }],
      network: Network.CHIPNET,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const matches = matchRpaPaymentsInRawTx(
      result.txHex,
      recipient,
      Network.CHIPNET
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].address).toBe(result.stealthAddress);
    expect(matches[0].valueSats).toBe(10_000);

    const stranger = await deriveRpaKeys(
      bip39.generateMnemonic(),
      '',
      Network.CHIPNET
    );
    expect(
      matchRpaPaymentsInRawTx(result.txHex, stranger, Network.CHIPNET)
    ).toEqual([]);
    expect(encodePaycode(
      recipient.scanPubkey,
      recipient.spendPubkey,
      Network.CHIPNET,
      8
    ).startsWith('cashcodetest:')).toBe(true);
  });

});
