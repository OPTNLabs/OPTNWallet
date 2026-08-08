// 2-of-3 round trip against the real SeedCash signer.
//
// The single-sig round trip proves the codec agrees with the device. This one
// proves the multisig path does, which is a different claim: P2SH scriptCode,
// one BIP32 record per cosigner, two independent devices signing the same
// unsigned transaction, a merge, and a CHECKMULTISIG unlock with Schnorr
// checkbits. Every one of those is somewhere the two sides could disagree
// while each looks internally correct.
//
// Opt-in, because it shells out to Python:
//   RUN_SEEDCASH_LIVE=1 npx vitest run src/services/psbt/__tests__/seedcashMultisigRoundtrip.test.ts

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  binToHex,
  createVirtualMachineBCH,
  decodeTransaction,
  encodeCashAddress,
  encodeTransaction,
  hash256,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';

import { buildWatchOnlyPsbt } from '../watchOnlySend';
import { inspectImportedPsbt, mergeImportedSignatures } from '../watchOnlyImport';
import { mergePsbts } from '../psbtMultisig';
import { deriveMultisigAddress, type MultisigPolicy } from '../multisigWallet';

const SIGNER = join(process.cwd(), 'scripts', 'seedcash', 'sign_psbt.py');
const CWD = join(process.cwd(), 'scripts', 'seedcash');
const ACCOUNT_PATH = "m/44'/145'/0'";

const describeLive = process.env.RUN_SEEDCASH_LIVE ? describe : describe.skip;

function seedcash(args: string[]): string {
  return execFileSync('python', [SIGNER, ...args], { cwd: CWD, encoding: 'utf8' });
}

describeLive('SeedCash 2-of-3 round trip', () => {
  it('two devices sign, OPTN merges, and the BCH VM accepts it', () => {
    const keys = JSON.parse(seedcash(['cosigner-keys', '3'])) as {
      xpub: string;
      fingerprint: string;
    }[];

    const policy: MultisigPolicy = {
      name: 'Live 2-of-3',
      m: 2,
      signers: keys.map((key, index) => ({
        name: `Cosigner ${index + 1}`,
        xpub: key.xpub,
        masterFingerprintHex: key.fingerprint,
        accountPath: ACCOUNT_PATH,
      })),
    };

    // The coin: a real parent transaction paying the 2-of-3 at 0/0.
    const spent = deriveMultisigAddress(policy, 0, 0);
    const satoshis = 100_000n;
    const parent = encodeTransaction({
      version: 2,
      inputs: [
        {
          outpointTransactionHash: new Uint8Array(32).fill(0x33),
          outpointIndex: 0,
          unlockingBytecode: new Uint8Array(),
          sequenceNumber: 0xffffffff,
        },
      ],
      outputs: [{ lockingBytecode: spent.lockingBytecode, valueSatoshis: satoshis }],
      locktime: 0,
    });
    const txid = binToHex(hash256(parent).slice().reverse());

    const change = deriveMultisigAddress(policy, 1, 0);
    const changeAddress = lockingBytecodeToCashAddress({
      bytecode: change.lockingBytecode,
      prefix: 'bchtest',
    });
    if (typeof changeAddress === 'string' || !('address' in changeAddress)) {
      throw new Error('could not encode multisig change address');
    }

    const inputs = [
      {
        txid,
        vout: 0,
        satoshis,
        lockingBytecodeHex: binToHex(spent.lockingBytecode),
        publicKeyHex: binToHex(spent.sortedPublicKeys[0]),
        branchIndex: 0 as const,
        addressIndex: 0,
        previousTransactionHex: binToHex(parent),
        redeemScriptHex: binToHex(spent.redeemScript),
        requiredSignatures: 2,
        cosignerDerivations: policy.signers.map((signer, index) => ({
          publicKeyHex: binToHex(spent.sortedPublicKeys[index]),
          masterFingerprintHex: signer.masterFingerprintHex!,
          derivationPath: `${ACCOUNT_PATH}/0/0`,
        })),
      },
    ];

    const built = buildWatchOnlyPsbt({
      inputs,
      recipient: encodeCashAddress({
        payload: Uint8Array.from([0x99, ...new Uint8Array(19).fill(0x77)]),
        prefix: 'bchtest',
        type: 'p2pkh',
      }).address,
      amountSats: 60_000n,
      changeAddress: changeAddress.address,
      accountPath: ACCOUNT_PATH,
      masterFingerprint: hexToBin(keys[0].fingerprint),
      changeRedeemScriptHex: binToHex(change.redeemScript),
      changeDerivations: policy.signers.map((signer, index) => ({
        publicKeyHex: binToHex(change.sortedPublicKeys[index]),
        masterFingerprintHex: signer.masterFingerprintHex!,
        derivationPath: `${ACCOUNT_PATH}/1/0`,
      })),
    });

    // Two independent devices sign the SAME unsigned transaction, each
    // knowing nothing about the other's signature.
    const dir = mkdtempSync(join(tmpdir(), 'seedcash-ms-'));
    const unsignedPath = join(dir, 'unsigned.hex');
    writeFileSync(unsignedPath, binToHex(built.psbtBytes));

    const partials = [0, 2].map((cosigner) => {
      const out = join(dir, `signed-${cosigner}.hex`);
      seedcash(['sign-as', String(cosigner), unsignedPath, out]);
      return hexToBin(readFileSync(out, 'utf8').trim());
    });

    const merged = mergePsbts(partials);
    // Every candidate must merge: a rejected one here would mean the two
    // devices disagreed about the transaction they were signing.
    expect(merged.results.filter((result) => !result.combined)).toEqual([]);

    const proposal = {
      rawUnsignedHex: built.rawUnsignedHex,
      inputs,
      outputs: built.outputs,
    };
    const inspected = inspectImportedPsbt(merged.merged, proposal);
    expect(inspected.state).toBe('complete');

    const rawTxHex = mergeImportedSignatures(merged.merged, proposal);
    const transaction = decodeTransaction(hexToBin(rawTxHex));
    if (typeof transaction === 'string') throw new Error(transaction);

    const vm = createVirtualMachineBCH();
    expect(
      vm.verify({
        sourceOutputs: [
          { lockingBytecode: spent.lockingBytecode, valueSatoshis: satoshis },
        ],
        transaction,
      })
    ).toBe(true);
  });
});
