import { describe, expect, it } from 'vitest';
import { MockNetworkProvider } from 'cashscript';
import {
  binToHex,
  createVirtualMachineBCH,
  decodeTransaction,
  deriveHdPath,
  deriveHdPrivateNodeFromSeed,
  deriveHdPublicNode,
  encodeHdPublicKey,
  generateSigningSerializationBch,
  hash256,
  hexToBin,
  lockingBytecodeToCashAddress,
  privateKeyToP2pkhLockingBytecode,
  secp256k1,
  type CompilationContextBch,
} from '@bitauth/libauth';

import { Network } from '../../../state/slices/networkSlice';
import {
  createBchnScanDescriptor,
  createMultisigDescriptorSet,
  deriveMultisigAddress,
  parseMultisigManifest,
  serializeMultisigManifest,
  stableCosignerId,
  type MultisigPolicy,
} from '../multisigWallet';
import { mergePsbts } from '../psbtMultisig';
import { buildWatchOnlyPsbt, parseBip32PathString } from '../watchOnlySend';
import {
  inspectImportedPsbt,
  mergeImportedSignatures,
} from '../watchOnlyImport';
import { encodeUnsignedPsbt, SIGHASH_ALL_FORKID } from '../psbtBch';
import { makeParentTransaction } from './parentFixture';

const ACCOUNT_PATH = "m/44'/145'/0'";
const SEED_BYTES = [0x01, 0x02, 0x03];
const FINGERPRINTS = ['aabbcc01', 'aabbcc02', 'aabbcc03'];

function accountXpub(seedByte: number): string {
  const master = deriveHdPrivateNodeFromSeed(
    new Uint8Array(32).fill(seedByte),
    { assumeValidity: true }
  );
  const account = deriveHdPath(master, ACCOUNT_PATH);
  if (typeof account === 'string') throw new Error(account);
  const encoded = encodeHdPublicKey({
    network: 'mainnet',
    node: deriveHdPublicNode(account),
  });
  if (typeof encoded === 'string') throw new Error(encoded);
  return encoded.hdPublicKey;
}

function childPrivateKey(seedByte: number, branch: 0 | 1, index: number) {
  const master = deriveHdPrivateNodeFromSeed(
    new Uint8Array(32).fill(seedByte),
    { assumeValidity: true }
  );
  const child = deriveHdPath(master, `${ACCOUNT_PATH}/${branch}/${index}`);
  if (typeof child === 'string') throw new Error(child);
  return Uint8Array.from(child.privateKey);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function signInput(
  unsignedTxHex: string,
  sourceOutput: { lockingBytecode: Uint8Array; valueSatoshis: bigint },
  privateKey: Uint8Array,
  redeemScript: Uint8Array
): Uint8Array {
  const decoded = decodeTransaction(hexToBin(unsignedTxHex));
  if (typeof decoded === 'string') throw new Error(decoded);
  const noTokens = {
    category: new Uint8Array(),
    amount: 0n,
    nft: undefined,
  };
  const context: CompilationContextBch = {
    transaction: decoded,
    inputIndex: 0,
    sourceOutputs: [{ ...sourceOutput, token: noTokens }],
  };
  const serialization = generateSigningSerializationBch(context, {
    coveredBytecode: redeemScript,
    signingSerializationType: Uint8Array.of(SIGHASH_ALL_FORKID),
  });
  const signature = secp256k1.signMessageHashSchnorr(
    privateKey,
    hash256(serialization)
  );
  return concat([signature as Uint8Array, Uint8Array.of(SIGHASH_ALL_FORKID)]);
}

describe('multisig descriptor to CashScript mocknet broadcast', () => {
  it('coordinates a descriptor, signs a P2SH20 spend, validates it in BCH VM, and broadcasts it', async () => {
    const policy: MultisigPolicy = {
      name: 'Mocknet Treasury',
      m: 2,
      schemaVersion: 1,
      network: Network.MAINNET,
      accountPath: ACCOUNT_PATH,
      policyRevision: 0,
      signers: SEED_BYTES.map((seedByte, index) => ({
        name: `Cosigner ${index + 1}`,
        xpub: accountXpub(seedByte),
        masterFingerprintHex: FINGERPRINTS[index],
        accountPath: ACCOUNT_PATH,
      })),
    };

    // This is the same canonical artifact every device coordinates on.
    const descriptors = createMultisigDescriptorSet(policy);
    const coordinatedPolicy = parseMultisigManifest(
      serializeMultisigManifest(policy),
      Network.MAINNET
    );
    expect(createMultisigDescriptorSet(coordinatedPolicy)).toEqual(descriptors);
    expect(descriptors.receive).toMatch(/^sh\(sortedmulti\(2,/);

    const receive = deriveMultisigAddress(policy, 0, 0);
    const change = deriveMultisigAddress(policy, 1, 0);
    expect(createBchnScanDescriptor(policy, 0, 0)).toBe(
      `sh(multi(2,${receive.sortedPublicKeys.map(binToHex).join(',')}))`
    );

    const receiveAddress = lockingBytecodeToCashAddress({
      bytecode: receive.lockingBytecode,
      prefix: 'bitcoincash',
    });
    const changeAddress = lockingBytecodeToCashAddress({
      bytecode: change.lockingBytecode,
      prefix: 'bitcoincash',
    });
    const recipientLockingBytecode = privateKeyToP2pkhLockingBytecode({
      privateKey: new Uint8Array(32).fill(0x44),
      throwErrors: true,
    });
    const recipientAddress = lockingBytecodeToCashAddress({
      bytecode: recipientLockingBytecode,
      prefix: 'bitcoincash',
    });
    if (
      typeof receiveAddress === 'string' ||
      typeof changeAddress === 'string' ||
      typeof recipientAddress === 'string'
    ) {
      throw new Error('Could not encode one of the mocknet CashAddr outputs.');
    }

    const parent = makeParentTransaction({
      lockingBytecode: receive.lockingBytecode,
      satoshis: 100_000n,
      seed: 0x55,
    });
    const provider = new MockNetworkProvider({ updateUtxoSet: true });
    provider.addUtxo(receiveAddress.address, {
      txid: parent.txid,
      vout: 0,
      satoshis: 100_000n,
    });
    expect(await provider.getUtxos(receiveAddress.address)).toHaveLength(1);

    const fingerprintFor = (cosignerId: string): string => {
      const signer = policy.signers.find(
        (candidate) =>
          (candidate.id ?? stableCosignerId(candidate.xpub)) === cosignerId
      );
      if (!signer?.masterFingerprintHex) {
        throw new Error(`No fingerprint for ${cosignerId}`);
      }
      return signer.masterFingerprintHex;
    };
    const derivationsFor = (
      address: ReturnType<typeof deriveMultisigAddress>
    ) =>
      address.derivedCosigners.map((cosigner) => ({
        publicKeyHex: binToHex(cosigner.publicKey),
        masterFingerprintHex: fingerprintFor(cosigner.cosignerId),
        derivationPath: cosigner.derivationPath,
      }));

    const input = {
      txid: parent.txid,
      previousTransactionHex: parent.hex,
      vout: 0,
      satoshis: 100_000n,
      lockingBytecodeHex: binToHex(receive.lockingBytecode),
      publicKeyHex: binToHex(receive.sortedPublicKeys[0]),
      branchIndex: 0 as const,
      addressIndex: 0,
      redeemScriptHex: binToHex(receive.redeemScript),
      requiredSignatures: 2,
      cosignerDerivations: derivationsFor(receive),
    };
    const proposal = buildWatchOnlyPsbt({
      inputs: [input],
      recipient: recipientAddress.address,
      amountSats: 50_000n,
      changeAddress: changeAddress.address,
      changeRedeemScriptHex: binToHex(change.redeemScript),
      changeDerivations: derivationsFor(change),
      accountPath: ACCOUNT_PATH,
      masterFingerprint: hexToBin(FINGERPRINTS[0]),
    });

    const partialPsbts = receive.derivedCosigners
      .slice(0, 2)
      .map((cosigner) => {
        const signerIndex = policy.signers.findIndex((signer) => {
          return (
            (signer.id ?? stableCosignerId(signer.xpub)) === cosigner.cosignerId
          );
        });
        if (signerIndex < 0)
          throw new Error('Could not match signing cosigner.');
        const signature = signInput(
          proposal.rawUnsignedHex,
          { lockingBytecode: receive.lockingBytecode, valueSatoshis: 100_000n },
          childPrivateKey(SEED_BYTES[signerIndex], 0, 0),
          receive.redeemScript
        );
        return encodeUnsignedPsbt(
          [
            {
              txid: parent.txid,
              vout: 0,
              satoshis: 100_000n,
              lockingBytecode: receive.lockingBytecode,
              previousTransaction: hexToBin(parent.hex),
              redeemScript: receive.redeemScript,
              derivations: receive.derivedCosigners.map((entry) => ({
                publicKey: entry.publicKey,
                masterFingerprint: hexToBin(fingerprintFor(entry.cosignerId)),
                derivationPath: parseBip32PathString(entry.derivationPath),
              })),
              partialSignatures: [
                {
                  inputIndex: 0,
                  publicKey: cosigner.publicKey,
                  signature,
                },
              ],
            },
          ],
          proposal.outputs.map((output) => ({
            lockingBytecode: hexToBin(output.lockingBytecodeHex),
            satoshis: output.satoshis,
            ...(output.isChange
              ? {
                  redeemScript: change.redeemScript,
                  derivations: change.derivedCosigners.map((entry) => ({
                    publicKey: entry.publicKey,
                    masterFingerprint: hexToBin(
                      fingerprintFor(entry.cosignerId)
                    ),
                    derivationPath: parseBip32PathString(entry.derivationPath),
                  })),
                }
              : {}),
          })),
          proposal.sighashType
        );
      });

    const merged = mergePsbts(partialPsbts).merged;
    const inspected = inspectImportedPsbt(merged, {
      rawUnsignedHex: proposal.rawUnsignedHex,
      inputs: [input],
      outputs: proposal.outputs,
      sighashType: proposal.sighashType,
    });
    expect(inspected.state).toBe('complete');

    const rawTransactionHex = mergeImportedSignatures(merged, {
      rawUnsignedHex: proposal.rawUnsignedHex,
      inputs: [input],
      outputs: proposal.outputs,
      sighashType: proposal.sighashType,
    });
    const transaction = decodeTransaction(hexToBin(rawTransactionHex));
    if (typeof transaction === 'string') throw new Error(transaction);
    expect(
      createVirtualMachineBCH().verify({
        sourceOutputs: [
          {
            lockingBytecode: receive.lockingBytecode,
            valueSatoshis: 100_000n,
          },
        ],
        transaction,
      })
    ).toBe(true);

    const broadcastTxid = await provider.sendRawTransaction(rawTransactionHex);
    expect(broadcastTxid).toBe(
      binToHex(hash256(hexToBin(rawTransactionHex)).slice().reverse())
    );
    expect(await provider.getUtxos(receiveAddress.address)).toHaveLength(0);
    const changeUtxos = await provider.getUtxos(changeAddress.address);
    expect(changeUtxos).toHaveLength(1);
    expect(changeUtxos[0]).toMatchObject({
      txid: broadcastTxid,
      vout: 1,
    });
    expect(changeUtxos[0].satoshis).toBe(proposal.changeSats);
    await expect(
      provider.sendRawTransaction(rawTransactionHex)
    ).rejects.toThrow(/already submitted/);
  });
});
