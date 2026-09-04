import {
  binToHex,
  decodeTransaction,
  generateSigningSerializationBch,
  hash256,
  secp256k1,
  type CompilationContextBch,
} from '@bitauth/libauth';

import KeyManager from '../../apis/WalletManager/KeyManager';
import {
  deriveHdPublicKeyAtPath,
  deriveMasterFingerprint,
  derivePrivateKeyAtPath,
} from '../HdWalletService';
import { zeroize } from '../../utils/secureMemory';
import {
  decodePsbt,
  encodeUnsignedPsbt,
  psbtTokenToTransactionToken,
  verifyBchSignature,
  SIGHASH_ALL_FORKID_ANYONECANPAY,
  type ParsedPsbt,
  type PsbtInputSpec,
  type PsbtOutputSpec,
  type PsbtSignature,
} from '../psbt/psbtBch';
import { formatBip32Path } from '../psbt/psbtMultisig';
import { loadMultisigPolicy } from './MultisigStorageService';
import { createMultisigDescriptorSet } from '../psbt/multisigWallet';
import {
  advanceMultisigSpendSession,
  assertMultisigSpendSessionBinding,
} from './MultisigSpendSessionService';

export type LocalSignatureAlgorithm = 'schnorr' | 'ecdsa';

export type MultisigLocalSignResult = {
  psbtBytes: Uint8Array;
  signedInputIndexes: number[];
  localCosignerId: string;
  masterFingerprintHex: string;
};

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function signatureAlgorithm(signature: PsbtSignature): LocalSignatureAlgorithm {
  return signature.signature.length - 1 === 64 ? 'schnorr' : 'ecdsa';
}

function expectedSignatureBody(
  privateKey: Uint8Array,
  hash: Uint8Array,
  algorithm: LocalSignatureAlgorithm
): Uint8Array {
  const signature =
    algorithm === 'schnorr'
      ? secp256k1.signMessageHashSchnorr(privateKey, hash)
      : secp256k1.signMessageHashDER(privateKey, hash);
  if (typeof signature === 'string')
    throw new Error(`BCH ${algorithm} signing failed.`);
  return Uint8Array.from(signature);
}

function buildSourceOutputs(
  parsed: ParsedPsbt
): CompilationContextBch['sourceOutputs'] {
  return parsed.inputs.map((input, index) => {
    if (!input.spentLockingBytecode || input.spentSatoshis === null) {
      throw new Error(`Input ${index} is missing its spent-output state.`);
    }
    if (input.token && !input.nonWitnessUtxo) {
      throw new Error(
        `Token-bearing input ${index} is missing its parent transaction.`
      );
    }
    return {
      lockingBytecode: input.spentLockingBytecode,
      valueSatoshis: input.spentSatoshis,
      ...(input.token
        ? { token: psbtTokenToTransactionToken(input.token) }
        : {}),
    };
  });
}

function encodeSignedPsbt(
  parsed: ParsedPsbt,
  signatures: PsbtSignature[]
): Uint8Array {
  const requested = parsed.requestedSighashTypes.filter(
    (type): type is number => type !== null
  );
  const sighashType = requested[0] ?? SIGHASH_ALL_FORKID_ANYONECANPAY;
  if (requested.some((type) => type !== sighashType)) {
    throw new Error('The PSBT requests inconsistent BCH sighash types.');
  }
  const inputs: PsbtInputSpec[] = parsed.inputs.map((input, index) => {
    if (
      !input.previousTxid ||
      input.outpointIndex === null ||
      input.spentSatoshis === null ||
      !input.spentLockingBytecode
    ) {
      throw new Error(`Input ${index} is missing complete PSBT signing state.`);
    }
    return {
      txid: binToHex(input.previousTxid),
      vout: input.outpointIndex,
      satoshis: input.spentSatoshis,
      lockingBytecode: input.spentLockingBytecode,
      previousTransaction: input.nonWitnessUtxo ?? undefined,
      token: input.token ?? undefined,
      redeemScript: input.redeemScript ?? undefined,
      derivations: input.derivations,
      sequence: input.sequence ?? 0xffffffff,
      partialSignatures: signatures.filter(
        (signature) => signature.inputIndex === index
      ),
    };
  });
  const outputs: PsbtOutputSpec[] = parsed.outputs.map((output) => ({
    lockingBytecode: output.lockingBytecode ?? new Uint8Array(),
    satoshis: output.satoshis ?? 0n,
    token: output.token ?? undefined,
    redeemScript: output.redeemScript ?? undefined,
    derivations: output.derivations.length > 0 ? output.derivations : undefined,
  }));
  return encodeUnsignedPsbt(inputs, outputs, sighashType, {
    globalXpubs: parsed.globalXpubs.length > 0 ? parsed.globalXpubs : undefined,
  });
}

/**
 * Sign only the local cosigner's child keys after the caller has completed the
 * explicit spend authorization step and the PSBT has been bound to a durable
 * session. No xprv or private key crosses this service boundary.
 */
export async function signMultisigPsbtLocally(args: {
  /** Wallet containing the shared policy and durable spend session. */
  policyWalletId: number;
  /** Standard mnemonic wallet containing this device's local seed. */
  signerWalletId: number;
  sessionId: string;
  policyId: string;
  unsignedTxHash: string;
  psbtBytes: Uint8Array;
  authorize: () => Promise<void>;
  algorithm?: LocalSignatureAlgorithm;
}): Promise<MultisigLocalSignResult> {
  await args.authorize();
  const parsed = decodePsbt(args.psbtBytes);
  const actualUnsignedTxHash = binToHex(hash256(parsed.unsignedTransaction));
  if (actualUnsignedTxHash !== args.unsignedTxHash) {
    throw new Error(
      'The PSBT unsigned transaction hash does not match the spend session.'
    );
  }
  const session = await assertMultisigSpendSessionBinding({
    ...args,
    walletId: args.policyWalletId,
  });
  const policy = await loadMultisigPolicy(args.policyWalletId);
  if (!policy)
    throw new Error('The multisig policy is not ready for local signing.');
  if (!policy.accountPath)
    throw new Error('The multisig policy has no account path.');
  const accountPath = policy.accountPath;
  const descriptorSet = createMultisigDescriptorSet(policy, policy.network);
  if (descriptorSet.policyId !== args.policyId) {
    throw new Error('The local signing policy binding is invalid.');
  }

  const algorithm = args.algorithm ?? 'schnorr';
  const keyManager = KeyManager();
  const result = await keyManager.withWalletSeedMaterial(
    args.signerWalletId,
    async (material) => {
      if (material.networkType !== policy.network) {
        throw new Error(
          'The local signer seed uses a different network than the policy.'
        );
      }
      const accountXpub = await deriveHdPublicKeyAtPath(
        material.mnemonic,
        material.passphrase,
        material.networkType,
        accountPath
      );
      const fingerprint = await deriveMasterFingerprint(
        material.mnemonic,
        material.passphrase
      );
      const fingerprintHex = binToHex(fingerprint);
      const localCosigner = policy.signers.find(
        (cosigner) =>
          cosigner.xpub === accountXpub &&
          cosigner.masterFingerprintHex?.toLowerCase() === fingerprintHex
      );
      if (!localCosigner) {
        throw new Error(
          'This wallet seed does not match any cosigner in the active policy.'
        );
      }
      const decoded = decodeTransaction(parsed.unsignedTransaction);
      if (typeof decoded === 'string')
        throw new Error('The PSBT unsigned transaction is invalid.');
      const sourceOutputs = buildSourceOutputs(parsed);
      const signatures = [...parsed.signatures];
      const signedInputIndexes: number[] = [];

      for (const [inputIndex, input] of parsed.inputs.entries()) {
        const derivation = input.derivations.find(
          (candidate) =>
            binToHex(candidate.masterFingerprint) === fingerprintHex &&
            formatBip32Path(candidate.derivationPath).startsWith(
              `${accountPath}/`
            )
        );
        if (!derivation) continue;
        if (input.redeemScript && !input.nonWitnessUtxo && input.token) {
          throw new Error(
            `Token-bearing multisig input ${inputIndex} lacks a parent transaction.`
          );
        }
        if (
          signatures.some(
            (signature) =>
              signature.inputIndex === inputIndex &&
              bytesEqual(signature.publicKey, derivation.publicKey)
          )
        ) {
          continue;
        }
        const existingAlgorithms = signatures
          .filter((signature) => signature.inputIndex === inputIndex)
          .map(signatureAlgorithm);
        if (existingAlgorithms.some((existing) => existing !== algorithm)) {
          throw new Error(
            `Input ${inputIndex} already contains a different signature algorithm.`
          );
        }

        const path = formatBip32Path(derivation.derivationPath);
        const privateKey = await derivePrivateKeyAtPath(
          material.mnemonic,
          material.passphrase,
          path
        );
        try {
          const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
          if (
            typeof publicKey === 'string' ||
            !bytesEqual(publicKey, derivation.publicKey)
          ) {
            throw new Error(
              `Derived local key does not match PSBT input ${inputIndex}. ` +
                'This proposal has stale or inconsistent cosigner derivation metadata; rebuild the spend before signing.'
            );
          }
          const coveredBytecode =
            input.redeemScript ?? input.spentLockingBytecode;
          if (!coveredBytecode)
            throw new Error(`Input ${inputIndex} has no signing script.`);
          const serialization = generateSigningSerializationBch(
            {
              transaction: decoded as CompilationContextBch['transaction'],
              inputIndex,
              sourceOutputs,
            },
            {
              coveredBytecode,
              signingSerializationType: Uint8Array.from([
                SIGHASH_ALL_FORKID_ANYONECANPAY,
              ]),
            }
          );
          const messageHash = hash256(serialization);
          const signatureBody = expectedSignatureBody(
            privateKey,
            messageHash,
            algorithm
          );
          if (!verifyBchSignature(signatureBody, publicKey, messageHash)) {
            throw new Error(
              `Local signature verification failed for input ${inputIndex}.`
            );
          }
          signatures.push({
            inputIndex,
            publicKey,
            signature: Uint8Array.from([
              ...signatureBody,
              SIGHASH_ALL_FORKID_ANYONECANPAY,
            ]),
          });
          signedInputIndexes.push(inputIndex);
        } finally {
          zeroize(privateKey);
        }
      }

      return {
        psbtBytes: encodeSignedPsbt(parsed, signatures),
        signedInputIndexes,
        localCosignerId: localCosigner.id ?? localCosigner.xpub,
        masterFingerprintHex: fingerprintHex,
      };
    }
  );

  await advanceMultisigSpendSession({
    sessionId: session.sessionId,
    stage: 'sign',
    psbtBytes: result.psbtBytes,
  });
  return result;
}

export default { signMultisigPsbtLocally };
