import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import {
  decodeTransaction,
  encodeTransaction,
  generatePrivateKey,
  hexToBin,
  secp256k1,
  type TransactionCommon,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { encodeCashAddress } from '@bitauth/libauth';
import { Network } from '../../state/slices/networkSlice';
import {
  computeSharedSecret,
  derivePaymentAddress,
  deriveRpaKeys,
  encodePaycode,
} from '../RpaService';
import {
  finalizeRpaPayment,
  rpaPrefixTargetHex,
  serializedInputPrefixHex,
} from '../RpaSender';
import { encodeTransactionInput } from '@bitauth/libauth';

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

describe('RpaSender', () => {
  it('rewrites a dummy output to the stealth address and matches the scan prefix', async () => {
    const recipient = await deriveRpaKeys(MNEMONIC, '', Network.CHIPNET);
    const paycode = encodePaycode(
      recipient.scanPubkey,
      recipient.spendPubkey,
      Network.CHIPNET,
      8
    );

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

    const prevTxid = '11'.repeat(32);
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

    const expectedDest = derivePaymentAddress(
      recipient.spendPubkey,
      computeSharedSecret(senderPriv, recipient.scanPubkey, prevTxid, 0),
      Network.CHIPNET,
      0
    );
    expect(result.stealthAddress).toBe(expectedDest);

    const decoded = decodeTransaction(hexToBin(result.txHex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const hashedPrefix = serializedInputPrefixHex(
      encodeTransactionInput(decoded.inputs[0]),
      8
    );
    expect(hashedPrefix).toBe(rpaPrefixTargetHex(recipient.scanPubkey, 8));
    expect(result.finalOutputs.some((o) => o.recipientAddress === expectedDest)).toBe(
      true
    );
    expect(paycode.startsWith('paycodetest:')).toBe(true);
  });
});
