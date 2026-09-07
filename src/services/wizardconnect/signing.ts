import {
  CompilationContextBCH,
  SigningSerializationFlag,
  binToHex,
  encodeTransaction,
  generateSigningSerializationBCH,
  hash256,
  hexToBin,
  importWalletTemplate,
  lockingBytecodeToCashAddress,
  secp256k1,
  sha256,
  type Transaction,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBCH,
} from '@bitauth/libauth';
import { DerivationPath } from '@wizardconnect/wallet';
import type { SignTransactionRequest } from '@wizardconnect/core';
import type { Network } from '../../state/slices/networkSlice';
import { PREFIX } from '../../utils/constants';
import { ensureUint8Array } from '../../utils/binary';
import { getPublicKeyCompressed } from '../../utils/hex';
import { zeroize } from '../../utils/secureMemory';
import { derivePrivateKeyForPath } from './derivation';
import { decodeWizardConnectTransaction } from './transaction';

type WalletSeedMaterial = {
  mnemonic: string;
  passphrase: string;
  network: Network;
  accountPath?: string;
};

function pathNameToDerivationPath(
  pathName: 'receive' | 'change' | 'defi'
): DerivationPath {
  switch (pathName) {
    case 'receive':
      return DerivationPath.Receive;
    case 'change':
      return DerivationPath.Change;
    case 'defi':
      return DerivationPath.Cauldron;
    default:
      throw new Error(`Unsupported path: ${String(pathName)}`);
  }
}

export async function signWizardConnectTransaction(
  request: SignTransactionRequest,
  wallet: WalletSeedMaterial
): Promise<string> {
  const { transaction: txDetails, sourceOutputs } =
    decodeWizardConnectTransaction(request.transaction);

  const template = importWalletTemplate({
    ...walletTemplateP2pkhNonHd,
    scripts: {
      ...walletTemplateP2pkhNonHd.scripts,
      unlock: {
        ...walletTemplateP2pkhNonHd.scripts.unlock,
        script:
          '<key.schnorr_signature.all_outputs_all_utxos> <key.public_key>',
      },
    },
  });
  if (typeof template === 'string') {
    throw new Error(template);
  }
  const compiler = walletTemplateToCompilerBCH(template);
  const txTemplate = {
    ...txDetails,
    inputs: txDetails.inputs.map((input) => ({ ...input })),
  } as Transaction;
  const inputPaths = new Map(
    request.inputPaths.map(([index, path, addressIndex]) => [
      index,
      { path, addressIndex },
    ])
  );
  const usedKeys = new Set<Uint8Array>();
  const networkPrefix = PREFIX[wallet.network];

  try {
    for (let i = 0; i < txTemplate.inputs.length; i += 1) {
      const input = txTemplate.inputs[i];
      const utxo = sourceOutputs[i];
      if (!utxo) {
        throw new Error(`Missing source output for input ${i}`);
      }

      const pathInfo = inputPaths.get(i);
      if (!pathInfo) {
        const existingUnlockingBytecode = input.unlockingBytecode;
        const hasPresetUnlocking =
          existingUnlockingBytecode instanceof Uint8Array ||
          Array.isArray(existingUnlockingBytecode);
        if (!hasPresetUnlocking) {
          throw new Error(
            `Missing WizardConnect input path for wallet-managed input ${i}`
          );
        }
        continue;
      }

      const signerKey = await derivePrivateKeyForPath(
        wallet.mnemonic,
        wallet.passphrase,
        wallet.network,
        pathNameToDerivationPath(pathInfo.path),
        BigInt(pathInfo.addressIndex),
        wallet.accountPath
      );
      usedKeys.add(signerKey);

      if (utxo.contract?.artifact?.contractName) {
        let hexUnlock = binToHex(ensureUint8Array(utxo.unlockingBytecode));
        const sigPlaceholder = '41' + binToHex(new Uint8Array(65).fill(0));
        const pubkeyPlaceholder = '21' + binToHex(new Uint8Array(33).fill(0));
        const hashType =
          SigningSerializationFlag.allOutputs |
          SigningSerializationFlag.utxos |
          SigningSerializationFlag.forkId;

        if (hexUnlock.includes(sigPlaceholder)) {
          const context = {
            inputIndex: i,
            sourceOutputs,
            transaction: txDetails as Transaction,
          } as CompilationContextBCH;
          const preimage = generateSigningSerializationBCH(context, {
            coveredBytecode: utxo.contract.redeemScript!,
            signingSerializationType: new Uint8Array([hashType]),
          });
          const sighash = hash256(preimage);
          const sig = secp256k1.signMessageHashSchnorr(
            signerKey,
            sighash
          ) as Uint8Array;
          const sigWithType = Uint8Array.from([...sig, hashType]);
          hexUnlock = hexUnlock.replace(
            sigPlaceholder,
            '41' + binToHex(sigWithType)
          );
        }

        if (hexUnlock.includes(pubkeyPlaceholder)) {
          const pubkey = getPublicKeyCompressed(signerKey, false) as Uint8Array;
          hexUnlock = hexUnlock.replace(
            pubkeyPlaceholder,
            '21' + binToHex(pubkey)
          );
        }

        input.unlockingBytecode = hexToBin(hexUnlock);
        continue;
      }

      // WizardConnect requires all UTXOs, including covenant inputs. The
      // generateTransaction helper only supplies the current input's output.
      const generated = compiler.generateBytecode({
        scriptId: 'unlock',
        data: {
          keys: { privateKeys: { key: signerKey } },
          compilationContext: {
            inputIndex: i,
            sourceOutputs,
            transaction: txTemplate,
          },
        },
      });
      if (!generated.success) {
        throw new Error('WizardConnect transaction signing failed');
      }
      input.unlockingBytecode = generated.bytecode;
    }

    const rawSigned = encodeTransaction(txTemplate);
    const txid = binToHex(sha256.hash(sha256.hash(rawSigned)).reverse());
    const signedTransaction = binToHex(rawSigned);

    if (request.transaction.broadcast) {
      try {
        const lockAddress = txTemplate.outputs
          .map((output) =>
            lockingBytecodeToCashAddress({
              prefix: networkPrefix,
              bytecode: ensureUint8Array(output.lockingBytecode),
            })
          )
          .find((result) => typeof result !== 'string');
        void lockAddress;
      } catch {
        // Best-effort validation only for this first pass.
      }
    }

    void txid;
    return signedTransaction;
  } finally {
    for (const key of usedKeys) {
      zeroize(key);
    }
  }
}
