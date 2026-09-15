import {
  CompilationContextBCH,
  binToHex,
  encodeTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
  sha256,
  type Transaction,
} from '@bitauth/libauth';
import { DerivationPath } from '@wizardconnect/wallet';
import type { SignTransactionRequest } from '@wizardconnect/core';
import type { Network } from '../../state/slices/networkSlice';
import { PREFIX } from '../../utils/constants';
import { ensureUint8Array } from '../../utils/binary';
import { zeroize } from '../../utils/secureMemory';
import { derivePrivateKeyForPath } from './derivation';
import { decodeWizardConnectTransaction } from './transaction';
import {
  CONNECT_ALL_OUTPUTS_ALL_UTXOS,
  connectorPublicKey,
  signConnectorInput,
  signConnectorP2pkh,
} from '../connect/ConnectSigningCore';

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
          (existingUnlockingBytecode instanceof Uint8Array ||
            Array.isArray(existingUnlockingBytecode)) &&
          existingUnlockingBytecode.length > 0;
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

        if (hexUnlock.includes(sigPlaceholder)) {
          const context = {
            inputIndex: i,
            sourceOutputs,
            transaction: txDetails as Transaction,
          } as CompilationContextBCH;
          if (!utxo.contract.redeemScript) {
            throw new Error('Missing WizardConnect covenant redeem script');
          }
          const sigWithType = signConnectorInput(
            context,
            signerKey,
            utxo.contract.redeemScript,
            CONNECT_ALL_OUTPUTS_ALL_UTXOS
          );
          hexUnlock = hexUnlock.replace(
            sigPlaceholder,
            '41' + binToHex(sigWithType)
          );
        }

        if (hexUnlock.includes(pubkeyPlaceholder)) {
          const pubkey = connectorPublicKey(signerKey);
          hexUnlock = hexUnlock.replace(
            pubkeyPlaceholder,
            '21' + binToHex(pubkey)
          );
        }

        input.unlockingBytecode = hexToBin(hexUnlock);
        continue;
      }

      input.unlockingBytecode = signConnectorP2pkh(
        {
          inputIndex: i,
          sourceOutputs,
          transaction: txTemplate,
        },
        signerKey
      );
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
