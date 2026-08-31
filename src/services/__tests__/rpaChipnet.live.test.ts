// The RPA cycle against a live chipnet network, end to end.
//
// The offline suites prove the three implementations agree with
// test-vectors/rpa.json. They cannot prove the wallet still works — every one
// of these steps now runs through crates/optn-core via wasm, and a binding that
// is wrong in a way the vectors do not cover would still pass them.
//
// Skipped unless you opt in and supply a funded wallet:
//
//   RUN_RPA_LIVE=1 \
//   RPA_LIVE_MNEMONIC="<12 words, holds chipnet coins>" \
//   npx vitest run src/services/__tests__/rpaChipnet.live.test.ts
//
// Optional:
//   RPA_LIVE_RECIPIENT_MNEMONIC  a second wallet to pay (default: generated)
//   RPA_LIVE_GAP                 addresses per chain to search (default 5)
//   RPA_LIVE_SATS                amount to send (default 50000)
//
// It spends real chipnet coins. They are worthless, but the transaction is
// permanent, so the wallet is yours to choose.
import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import {
  binToHex,
  cashAddressToLockingBytecode,
  decodeTransaction,
  encodeCashAddress,
  encodeTransaction,
  hexToBin,
  secp256k1,
  sha256,
  type TransactionCommon,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { Network } from '../../state/slices/networkSlice';
import { derivePrivateKeyAtPath, getBchAddressPath } from '../HdWalletService';
import {
  computeSharedSecret,
  decodePaycode,
  deriveAndEncodePaycode,
  deriveRpaKeys,
  deriveSpendingKey,
} from '../RpaService';
import { finalizeRpaPayment } from '../RpaSender';
import { matchRpaPaymentsInRawTx } from '../RpaDetect';
import { anyServer } from '../../../test-support/chipnetElectrum';

const FEE_SATS = 2_000;

const senderMnemonic = process.env.RPA_LIVE_MNEMONIC ?? '';
const recipientMnemonic =
  process.env.RPA_LIVE_RECIPIENT_MNEMONIC || bip39.generateMnemonic();
const gap = Number(process.env.RPA_LIVE_GAP ?? 5);
const paySats = Number(process.env.RPA_LIVE_SATS ?? 50_000);

const enabled =
  process.env.RUN_RPA_LIVE === '1' && senderMnemonic.trim().length > 0;

function p2pkhLock(pubkey: Uint8Array): Uint8Array {
  return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160(pubkey), 0x88, 0xac]);
}

function addressOf(pubkey: Uint8Array): string {
  const encoded = encodeCashAddress({
    prefix: 'bchtest',
    type: 'p2pkh',
    payload: hash160(pubkey),
  });
  if (typeof encoded === 'string') throw new Error(encoded);
  return encoded.address;
}

function electrumScripthash(address: string): string {
  const lock = cashAddressToLockingBytecode(address);
  if (typeof lock === 'string') throw new Error(lock);
  return binToHex(sha256.hash(lock.bytecode).reverse());
}

type Coin = { tx_hash: string; tx_pos: number; value: number };

/** The largest spendable coin in the wallet, and the key that unlocks it. */
async function findLargestCoin(mnemonic: string): Promise<{
  coin: Coin;
  privkey: Uint8Array;
  pubkey: Uint8Array;
  address: string;
  path: string;
}> {
  let best: Awaited<ReturnType<typeof findLargestCoin>> | null = null;

  for (const change of [false, true]) {
    for (let index = 0; index < gap; index++) {
      const path = getBchAddressPath(Network.CHIPNET, 0, change ? 1 : 0, index);
      const privkey = await derivePrivateKeyAtPath(mnemonic, '', path);
      const pubkeyRaw = secp256k1.derivePublicKeyCompressed(privkey);
      if (typeof pubkeyRaw === 'string') throw new Error(pubkeyRaw);
      const pubkey = Uint8Array.from(pubkeyRaw);
      const address = addressOf(pubkey);

      const answer = await anyServer([
        [1, 'blockchain.scripthash.listunspent', [electrumScripthash(address)]],
      ]);
      for (const coin of (answer.results[1] as Coin[] | undefined) ?? []) {
        if (!best || coin.value > best.coin.value) {
          best = { coin, privkey, pubkey, address, path };
        }
      }
    }
  }

  if (!best) {
    throw new Error(
      `No chipnet coins found in the first ${gap} addresses of each chain. ` +
        'Fund the wallet, or raise RPA_LIVE_GAP.'
    );
  }
  return best;
}

describe.skipIf(!enabled)('RPA on chipnet', () => {
  it('pays a cashcode, finds it again by scanning, and can spend it', async () => {
    const sender = await findLargestCoin(senderMnemonic);
    expect(sender.coin.value).toBeGreaterThan(paySats + FEE_SATS);
    console.log(
      `\ncoin        : ${sender.coin.tx_hash}:${sender.coin.tx_pos} = ` +
        `${sender.coin.value} sats at ${sender.path}`
    );

    // The recipient publishes a cashcode.
    const recipient = await deriveRpaKeys(
      recipientMnemonic,
      '',
      Network.CHIPNET
    );
    const cashcode = await deriveAndEncodePaycode(
      recipientMnemonic,
      '',
      Network.CHIPNET
    );
    expect(cashcode.startsWith('cashcodetest:')).toBe(true);
    const decoded = decodePaycode(cashcode);
    expect(decoded).not.toBeNull();

    // A draft with a dummy destination and change, as useSimpleSend builds.
    // The dummy needs a key of its own: finalizeRpaPayment replaces the dummy
    // output and then asserts none survives, so sharing a script with the
    // change output makes that assertion fire on the change.
    const dummyPath = getBchAddressPath(Network.CHIPNET, 0, 1, gap + 1);
    const dummyPrivkey = await derivePrivateKeyAtPath(
      senderMnemonic,
      '',
      dummyPath
    );
    const dummyPubkeyRaw = secp256k1.derivePublicKeyCompressed(dummyPrivkey);
    if (typeof dummyPubkeyRaw === 'string') throw new Error(dummyPubkeyRaw);
    const dummyPubkey = Uint8Array.from(dummyPubkeyRaw);

    const draft: TransactionCommon = {
      version: 2,
      locktime: 0,
      inputs: [
        {
          // Display order. libauth writes the little-endian wire form itself.
          outpointTransactionHash: hexToBin(sender.coin.tx_hash),
          outpointIndex: sender.coin.tx_pos,
          sequenceNumber: 0xffffffff,
          unlockingBytecode: Uint8Array.of(),
        },
      ],
      outputs: [
        {
          lockingBytecode: p2pkhLock(dummyPubkey),
          valueSatoshis: BigInt(paySats),
        },
        {
          lockingBytecode: p2pkhLock(sender.pubkey),
          valueSatoshis: BigInt(sender.coin.value - paySats - FEE_SATS),
        },
      ],
    };

    const started = Date.now();
    const sent = await finalizeRpaPayment({
      rawTxHex: binToHex(encodeTransaction(draft)),
      dummyAddress: addressOf(dummyPubkey),
      paycode: decoded!,
      utxos: [
        {
          address: sender.address,
          height: 0,
          tx_hash: sender.coin.tx_hash,
          tx_pos: sender.coin.tx_pos,
          value: sender.coin.value,
          amount: sender.coin.value,
        },
      ],
      inputKeys: [{ priv: sender.privkey, pub: sender.pubkey }],
      network: Network.CHIPNET,
    });
    if (!sent.ok) throw new Error(`finalize failed: ${sent.error}`);
    console.log(`grind       : ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`stealth     : ${sent.stealthAddress}`);

    const broadcast = await anyServer([
      [1, 'blockchain.transaction.broadcast', [sent.txHex]],
    ]);
    const txid = broadcast.results[1];
    expect(typeof txid).toBe('string');
    console.log(`txid        : ${txid}`);

    // Re-fetch from the network rather than trusting the local copy, then scan.
    const fetched = await anyServer([
      [1, 'blockchain.transaction.get', [txid, false]],
    ]);
    const raw = fetched.results[1] as string;
    expect(typeof raw).toBe('string');

    const matches = matchRpaPaymentsInRawTx(raw, recipient, Network.CHIPNET);
    expect(matches).toHaveLength(1);
    expect(matches[0].address).toBe(sent.stealthAddress);
    expect(matches[0].valueSats).toBe(paySats);
    console.log(
      `scanned     : ${matches[0].address} ${matches[0].valueSats} sats`
    );

    // The property that matters: the recipient can move it.
    const shared = computeSharedSecret(
      recipient.scanPrivkey,
      sender.pubkey,
      matches[0].prevoutHash,
      matches[0].prevoutIndex
    );
    const spendPrivkey = await deriveSpendingKey(
      recipient.spendPrivkey,
      shared,
      0
    );
    const spendPubkey = secp256k1.derivePublicKeyCompressed(spendPrivkey);
    if (typeof spendPubkey === 'string') throw new Error(spendPubkey);

    const onChain = decodeTransaction(hexToBin(raw));
    if (typeof onChain === 'string') throw new Error(onChain);
    expect(
      binToHex(onChain.outputs[matches[0].outputIndex].lockingBytecode)
    ).toBe(binToHex(p2pkhLock(Uint8Array.from(spendPubkey))));
    console.log('spendable   : yes');
    console.log(`explorer    : https://bchexplorer.cash/chipnet/tx/${txid}\n`);
  }, 900_000);
});
