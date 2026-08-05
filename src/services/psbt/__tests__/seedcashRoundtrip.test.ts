// Round trip against the real SeedCash signer, not a model of it.
//
// Every other test here signs with our own secp256k1 calls, which proves our
// verifier agrees with itself. This one hands the PSBT bytes to SeedCash's
// actual `sign_psbt_with_xpriv` (via scripts/seedcash/sign_psbt.py) and feeds
// the result back through import + finalize, then executes the finished
// transaction on libauth's BCH VM. That is the only way to catch the class of
// bug where both sides are internally consistent and disagree with each other
// — which is exactly what a DER-only verifier against a Schnorr signer was.
//
// Opt-in, because it shells out to Python:
//   RUN_SEEDCASH_LIVE=1 npx vitest run src/services/psbt/__tests__/seedcashRoundtrip.test.ts

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  binToHex,
  createVirtualMachineBCH,
  decodeHdPublicKey,
  decodeTransaction,
  deriveHdPathRelative,
  encodeCashAddress,
  encodeTransaction,
  hash160,
  hash256,
  hexToBin,
} from '@bitauth/libauth';

import { buildWatchOnlyPsbt } from '../watchOnlySend';
import { inspectImportedPsbt, mergeImportedSignatures } from '../watchOnlyImport';

const SIGNER = join(process.cwd(), 'scripts', 'seedcash', 'sign_psbt.py');
const CWD = join(process.cwd(), 'scripts', 'seedcash');

const describeLive = process.env.RUN_SEEDCASH_LIVE ? describe : describe.skip;

function seedcash(args: string[]): string {
  return execFileSync('python', [SIGNER, ...args], {
    cwd: CWD,
    encoding: 'utf8',
  });
}

function p2pkhScript(publicKey: Uint8Array): Uint8Array {
  const script = new Uint8Array(25);
  script[0] = 0x76;
  script[1] = 0xa9;
  script[2] = 0x14;
  script.set(hash160(publicKey), 3);
  script[23] = 0x88;
  script[24] = 0xac;
  return script;
}

describeLive('SeedCash round trip', () => {
  it('signs an OPTN PSBT and the result executes on the BCH VM', () => {
    const keys = JSON.parse(seedcash(['keys'])) as {
      xpub: string;
      fingerprint: string;
      accountPath: string;
    };

    // Derive the change-branch key the same way the watch-only wallet does, so
    // the input is one SeedCash can claim through its fingerprint.
    const account = decodeHdPublicKey(keys.xpub);
    if (typeof account === 'string') throw new Error(account);
    const child = deriveHdPathRelative(account.node, '1/0');
    if (typeof child === 'string') throw new Error(child);
    const publicKey = child.publicKey;

    const lockingBytecode = p2pkhScript(publicKey);
    const satoshis = 50_000n;

    // A real parent transaction paying the watched address, so the PSBT can
    // carry PSBT_IN_NON_WITNESS_UTXO. Its txid is whatever it hashes to —
    // the decoder checks that against the outpoint, so it cannot be invented.
    const parent = {
      version: 2,
      inputs: [
        {
          outpointTransactionHash: new Uint8Array(32).fill(0x11),
          outpointIndex: 0,
          unlockingBytecode: new Uint8Array(),
          sequenceNumber: 0xffffffff,
        },
      ],
      outputs: [{ lockingBytecode, valueSatoshis: satoshis }],
      locktime: 0,
    };
    const parentBytes = encodeTransaction(parent);
    const parentTxid = binToHex(hash256(parentBytes).slice().reverse());

    const inputs = [
      {
        txid: parentTxid,
        vout: 0,
        satoshis,
        lockingBytecodeHex: binToHex(lockingBytecode),
        publicKeyHex: binToHex(publicKey),
        branchIndex: 1 as const,
        addressIndex: 0,
        previousTransactionHex: binToHex(parentBytes),
      },
    ];
    const built = buildWatchOnlyPsbt({
      inputs,
      recipient: encodeCashAddress({
        payload: Uint8Array.from([0x99, ...new Uint8Array(19).fill(0x77)]),
        prefix: 'bchtest',
        type: 'p2pkh',
      }).address,
      amountSats: 30_000n,
      changeAddress: encodeCashAddress({
        payload: hash160(publicKey),
        prefix: 'bchtest',
        type: 'p2pkh',
      }).address,
      accountPath: keys.accountPath,
      masterFingerprint: hexToBin(keys.fingerprint),
    });

    const proposal = {
      rawUnsignedHex: built.rawUnsignedHex,
      inputs,
      outputs: built.outputs,
    };

    const dir = mkdtempSync(join(tmpdir(), 'seedcash-'));
    const unsignedPath = join(dir, 'unsigned.hex');
    const signedPath = join(dir, 'signed.hex');
    writeFileSync(unsignedPath, binToHex(built.psbtBytes));
    seedcash(['sign', unsignedPath, signedPath]);
    const signed = hexToBin(readFileSync(signedPath, 'utf8').trim());

    const inspected = inspectImportedPsbt(signed, proposal);
    expect(inspected.state).toBe('complete');

    const rawTxHex = mergeImportedSignatures(signed, proposal);

    // The real gate: run the finished transaction against consensus rules.
    // A wrong dummy element, signature algorithm or sighash byte all survive
    // every structural check above and die precisely here.
    const vm = createVirtualMachineBCH();
    const transaction = decodeTransaction(hexToBin(rawTxHex));
    if (typeof transaction === 'string') throw new Error(transaction);
    const verdict = vm.verify({
      sourceOutputs: [{ lockingBytecode, valueSatoshis: satoshis }],
      transaction,
    });
    expect(verdict).toBe(true);
  });
});
