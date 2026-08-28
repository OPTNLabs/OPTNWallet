// End-to-end proof that money sent to a cashcode is recoverable.
//
// The compressed-vs-uncompressed change decides which pubkey gets hashed into
// the one-time P2PKH. Get it wrong and funds land on an address nobody holds
// the key to, silently. Asserting an address string cannot catch that — so
// this walks the whole cycle through the production code and then runs the
// BCH VM twice: once on the payment, once on the recipient spending it.
//
//   sender pays a code -> VM accepts the payment tx
//     -> recipient scans the raw tx and finds the output
//     -> recipient derives the spending key
//     -> that key's pubkey hash IS the output's locking bytecode
//     -> recipient sweeps it and the VM accepts that too
//
// Run for a cashcode: target and a legacy paycode: target, since both must
// pay the same compressed form.
import { describe, expect, it } from 'vitest';
import * as bip39 from 'bip39';
import {
  binToHex,
  createVirtualMachineBch2025,
  decodeTransaction,
  encodeCashAddress,
  encodeTransaction,
  generatePrivateKey,
  generateSigningSerializationBCH,
  hashTransactionP2pOrder,
  hash256,
  hexToBin,
  secp256k1,
  SigningSerializationFlag,
  type CompilationContextBCH,
  type Output,
  type TransactionCommon,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { Network } from '../../state/slices/networkSlice';
import {
  computeSharedSecret,
  decodePaycode,
  deriveRpaKeys,
  deriveSpendingKey,
  encodePaycode,
  type RpaPrefixFamily,
} from '../RpaService';
import { finalizeRpaPayment } from '../RpaSender';
import { matchRpaPaymentsInRawTx } from '../RpaDetect';

const HASHTYPE =
  SigningSerializationFlag.allOutputs | SigningSerializationFlag.forkId;

const vm = createVirtualMachineBch2025();

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

function randomKeypair(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = generatePrivateKey(() =>
    crypto.getRandomValues(new Uint8Array(32))
  );
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pub === 'string') throw new Error(pub);
  return { priv, pub: Uint8Array.from(pub) };
}

/** Sign input `index` as P2PKH, the same way RpaSender does. */
function signP2pkhInput(
  transaction: TransactionCommon,
  sourceOutputs: Output[],
  index: number,
  priv: Uint8Array,
  pub: Uint8Array
): void {
  const context: CompilationContextBCH = {
    inputIndex: index,
    sourceOutputs,
    transaction,
  };
  const preimage = generateSigningSerializationBCH(context, {
    coveredBytecode: p2pkhLock(pub),
    signingSerializationType: Uint8Array.of(HASHTYPE),
  });
  const sig = secp256k1.signMessageHashSchnorr(priv, hash256(preimage));
  if (typeof sig === 'string') throw new Error(`schnorr sign failed: ${sig}`);
  const sigPush = Uint8Array.from([...sig, HASHTYPE]);
  transaction.inputs[index].unlockingBytecode = Uint8Array.from([
    sigPush.length,
    ...sigPush,
    pub.length,
    ...pub,
  ]);
}

/** vm.verify returns `true` on success, or a string describing the failure. */
function expectVmAccepts(
  sourceOutputs: Output[],
  transaction: TransactionCommon
): void {
  const verdict = vm.verify({ sourceOutputs, transaction });
  expect(verdict).toBe(true);
}

async function runRoundTrip(family: RpaPrefixFamily): Promise<void> {
  // Recipient publishes a code
  const recipient = await deriveRpaKeys(
    bip39.generateMnemonic(),
    '',
    Network.CHIPNET
  );
  const code = encodePaycode(
    recipient.scanPubkey,
    recipient.spendPubkey,
    Network.CHIPNET,
    8,
    family
  );
  const decoded = decodePaycode(code);
  expect(decoded).not.toBeNull();
  expect(decoded!.legacy).toBe(family === 'legacy-paycode');

  // Sender holds one funded P2PKH coin
  const sender = randomKeypair();
  const dummy = randomKeypair();
  const prevTxid = '0123456789abcdef'.repeat(4);
  const fundingSats = 61_000n;
  const fundingOutputs: Output[] = [
    { lockingBytecode: p2pkhLock(sender.pub), valueSatoshis: fundingSats },
  ];

  const draft: TransactionCommon = {
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
      { lockingBytecode: p2pkhLock(dummy.pub), valueSatoshis: 10_000n },
      { lockingBytecode: p2pkhLock(sender.pub), valueSatoshis: 50_000n },
    ],
  };

  const sent = await finalizeRpaPayment({
    rawTxHex: Buffer.from(encodeTransaction(draft)).toString('hex'),
    dummyAddress: addressOf(dummy.pub),
    paycode: decoded!,
    utxos: [
      {
        address: addressOf(sender.pub),
        height: 1,
        tx_hash: prevTxid,
        tx_pos: 0,
        value: Number(fundingSats),
        amount: Number(fundingSats),
      },
    ],
    inputKeys: [{ priv: sender.priv, pub: sender.pub }],
    network: Network.CHIPNET,
  });
  expect(sent.ok).toBe(true);
  if (!sent.ok) return;

  // 1. The payment transaction is valid on-chain
  const paymentTx = decodeTransaction(hexToBin(sent.txHex));
  if (typeof paymentTx === 'string') throw new Error(paymentTx);
  expectVmAccepts(fundingOutputs, paymentTx);

  // 2. Recipient finds it by scanning the raw transaction
  const matches = matchRpaPaymentsInRawTx(
    sent.txHex,
    recipient,
    Network.CHIPNET
  );
  expect(matches).toHaveLength(1);
  const match = matches[0];
  expect(match.address).toBe(sent.stealthAddress);

  // 3. Recipient derives the key for that specific output
  const shared = computeSharedSecret(
    recipient.scanPrivkey,
    sender.pub,
    match.prevoutHash,
    match.prevoutIndex
  );
  const spendPriv = await deriveSpendingKey(recipient.spendPrivkey, shared, 0);
  const spendPub = secp256k1.derivePublicKeyCompressed(spendPriv);
  if (typeof spendPub === 'string') throw new Error(spendPub);

  // 4. That key really controls the output that got paid.
  // This is the assertion the compressed/uncompressed bug would break: the
  // locking bytecode must hash the COMPRESSED pubkey of the derived key.
  const stealthOutput = paymentTx.outputs[match.outputIndex];
  expect(binToHex(stealthOutput.lockingBytecode)).toBe(
    binToHex(p2pkhLock(Uint8Array.from(spendPub)))
  );

  // 5. Recipient actually spends it, and the VM accepts
  const sweep: TransactionCommon = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: hashTransactionP2pOrder(
          encodeTransaction(paymentTx)
        ),
        outpointIndex: match.outputIndex,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: Uint8Array.of(),
      },
    ],
    outputs: [
      {
        lockingBytecode: p2pkhLock(sender.pub),
        valueSatoshis: stealthOutput.valueSatoshis - 500n,
      },
    ],
  };
  signP2pkhInput(sweep, [stealthOutput], 0, spendPriv, Uint8Array.from(spendPub));
  expectVmAccepts([stealthOutput], sweep);
}

describe('RPA round trip: pay a code, then spend what lands', () => {
  it('cashcode: payment is valid, detected, and spendable by the recipient', async () => {
    await runRoundTrip('cashcode');
  });

  it('legacy paycode: payment is valid, detected, and spendable by the recipient', async () => {
    await runRoundTrip('legacy-paycode');
  });
});
