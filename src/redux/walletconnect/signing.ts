import {
  importWalletTemplate,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBCH,
  generateTransaction,
  encodeTransaction,
  sha256,
  binToHex,
  hexToBin,
  type TransactionCommon,
  type TransactionTemplateFixed,
  type Input,
  type Output,
  SigningSerializationFlag,
  CompilationContextBCH,
  generateSigningSerializationBCH,
  hash256,
  secp256k1,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import type { WalletKitTypes } from '@reown/walletkit';
import type { RootState } from '../store';
import KeyService from '../../services/KeyService';
import { parseExtendedJson } from '../../utils/parseExtendedJson';
import type { ContractInfo } from '../../types/wcInterfaces';
import { getPublicKeyCompressed } from '../../utils/hex';
import TransactionService from '../../services/TransactionService';
import { ensureUint8Array } from '../../utils/binary';
import { PREFIX } from '../../utils/constants';
import { normalizeWalletAddressCandidate } from './helpers';
import { zeroize } from '../../utils/secureMemory';

type SignedTxObject = {
  signedTransaction: string;
  signedTransactionHash: string;
};

export async function signWalletConnectTransactionRequest(
  signTxRequest: WalletKitTypes.SessionRequest,
  state: RootState
): Promise<{
  id: number;
  topic: string;
  signedTxObject: SignedTxObject;
}> {
  const { id, topic, params } = signTxRequest;
  const rawParams = params.request.params as unknown;
  const request = parseExtendedJson(JSON.stringify(rawParams));
  const txDetails = request.transaction as TransactionCommon;
  const sourceOutputs = request.sourceOutputs as (Input & Output & ContractInfo)[];
  if (!txDetails || !sourceOutputs) {
    throw new Error('Malformed WalletConnect transaction request');
  }

  const walletId = state.wallet_id.currentWalletId!;
  const keys = await KeyService.retrieveKeys(walletId);
  if (!keys.length) throw new Error('No key available');
  const keyAddressSet = new Set(keys.map((k) => k.address));
  const networkPrefix = PREFIX[state.network.currentNetwork];
  const rawRequestRecord =
    request && typeof request === 'object'
      ? (request as Record<string, unknown>)
      : {};
  const requestedSignerAddress = [rawRequestRecord.account, rawRequestRecord.address]
    .filter((value): value is string => typeof value === 'string')
    .map((candidate) => normalizeWalletAddressCandidate(candidate, networkPrefix))
    .find((candidate): candidate is string =>
      !!candidate && keyAddressSet.has(candidate)
    );

  const defaultSignerAddress = requestedSignerAddress ?? keys[0].address;
  const defaultPrivateKey = await KeyService.fetchAddressPrivateKey(defaultSignerAddress);
  if (!defaultPrivateKey) throw new Error('Private key not found');
  const usedKeys = new Set<Uint8Array>([defaultPrivateKey]);

  try {
    const template = importWalletTemplate(walletTemplateP2pkhNonHd);
    if (typeof template === 'string') throw new Error(template);
    const compiler = walletTemplateToCompilerBCH(template);

    const txTemplate = { ...txDetails } as TransactionTemplateFixed<typeof compiler>;
    for (let i = 0; i < txTemplate.inputs.length; i++) {
      const input = txTemplate.inputs[i];
      const utxo = sourceOutputs[i];
      const sourceAddress = (() => {
        const typed = utxo as { address?: unknown; lockingBytecode?: unknown };
        if (typeof typed.address === 'string') {
          return normalizeWalletAddressCandidate(typed.address, networkPrefix);
        }
        if (typed.lockingBytecode == null) return null;
        const addressResult = lockingBytecodeToCashAddress({
          prefix: networkPrefix,
          bytecode: ensureUint8Array(typed.lockingBytecode),
        });
        if (typeof addressResult === 'string') return null;
        return addressResult.address;
      })();

      if (sourceAddress && !keyAddressSet.has(sourceAddress)) {
        throw new Error(`Refusing to sign non-wallet input: ${sourceAddress}`);
      }

      const signerKey =
        sourceAddress && keyAddressSet.has(sourceAddress)
          ? await KeyService.fetchAddressPrivateKey(sourceAddress)
          : defaultPrivateKey;
      if (!signerKey) {
        throw new Error('Missing private key for signing input');
      }
      usedKeys.add(signerKey);

      if (utxo.contract?.artifact?.contractName) {
        let hexUnlock = binToHex(utxo.unlockingBytecode);
        const sigPlaceholder = '41' + binToHex(new Uint8Array(65).fill(0));
        const pubkeyPlaceholder = '21' + binToHex(new Uint8Array(33).fill(0));

        if (hexUnlock.includes(sigPlaceholder)) {
          const hashType =
            SigningSerializationFlag.allOutputs |
            SigningSerializationFlag.utxos |
            SigningSerializationFlag.forkId;
          const context = {
            inputIndex: i,
            sourceOutputs,
            transaction: txDetails,
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
          hexUnlock = hexUnlock.replace(pubkeyPlaceholder, '21' + binToHex(pubkey));
        }

        input.unlockingBytecode = hexToBin(hexUnlock);
      } else {
        input.unlockingBytecode = {
          compiler,
          data: { keys: { privateKeys: { key: signerKey } } },
          valueSatoshis: utxo.valueSatoshis,
          script: 'unlock',
          token: utxo.token,
        };
      }
    }

    const generated = generateTransaction(txTemplate);
    if (!generated.success) {
      throw new Error('Transaction signing failed');
    }
    const rawSigned = encodeTransaction(generated.transaction);
    const rawSignedHex = binToHex(rawSigned);
    const txid = binToHex(sha256.hash(sha256.hash(rawSigned)).reverse());

    const signedTxObject: SignedTxObject = {
      signedTransaction: rawSignedHex,
      signedTransactionHash: txid,
    };

    if (request.broadcast) {
      try {
        const sessionMeta = state.walletconnect.activeSessions?.[topic]?.peer?.metadata;
        const sent = await TransactionService.sendTransaction(
          rawSignedHex,
          undefined,
          {
            source: 'walletconnect',
            sourceLabel: sessionMeta?.name
              ? `WalletConnect: ${sessionMeta.name}`
              : 'WalletConnect broadcast',
            sessionTopic: topic,
            dappName: sessionMeta?.name ?? null,
            dappUrl: sessionMeta?.url ?? null,
            requestId: String(id),
            userPrompt:
              typeof request.userPrompt === 'string' ? request.userPrompt : null,
            amountSummary: `${txDetails.outputs.length} output${
              txDetails.outputs.length === 1 ? '' : 's'
            }`,
          }
        );
        if (sent.errorMessage) {
          throw new Error(sent.errorMessage);
        }
      } catch {
        console.warn('Broadcast failed, returning signed hex anyway');
      }
    }

    return { id, topic, signedTxObject };
  } finally {
    for (const key of usedKeys) {
      zeroize(key);
    }
  }
}
