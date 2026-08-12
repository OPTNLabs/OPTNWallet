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
} from '@bitauth/libauth';
import type { WalletKitTypes } from '@reown/walletkit';
import type { RootState } from '../store';
import KeyService from '../../services/KeyService';
import { parseExtendedJson } from '../../utils/parseExtendedJson';
import type { ContractInfo } from '../../types/wcInterfaces';
import { getPublicKeyCompressed } from '../../utils/hex';
import TransactionService from '../../services/TransactionService';

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
  const [firstKey] = await KeyService.retrieveKeys(walletId);
  if (!firstKey) throw new Error('No key available');
  const privKey = await KeyService.fetchAddressPrivateKey(firstKey.address);
  if (!privKey) throw new Error('Private key not found');

  const template = importWalletTemplate(walletTemplateP2pkhNonHd);
  if (typeof template === 'string') throw new Error(template);
  const compiler = walletTemplateToCompilerBCH(template);

  const txTemplate = { ...txDetails } as TransactionTemplateFixed<typeof compiler>;
  for (let i = 0; i < txTemplate.inputs.length; i++) {
    const input = txTemplate.inputs[i];
    const utxo = sourceOutputs[i];

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
          privKey,
          sighash
        ) as Uint8Array;
        const sigWithType = Uint8Array.from([...sig, hashType]);
        hexUnlock = hexUnlock.replace(
          sigPlaceholder,
          '41' + binToHex(sigWithType)
        );
      }

      if (hexUnlock.includes(pubkeyPlaceholder)) {
        const pubkey = getPublicKeyCompressed(privKey, false) as Uint8Array;
        hexUnlock = hexUnlock.replace(pubkeyPlaceholder, '21' + binToHex(pubkey));
      }

      input.unlockingBytecode = hexToBin(hexUnlock);
    } else {
      input.unlockingBytecode = {
        compiler,
        data: { keys: { privateKeys: { key: privKey } } },
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
      await TransactionService.sendTransaction(rawSignedHex);
    } catch {
      console.warn('Broadcast failed, returning signed hex anyway');
    }
  }

  return { id, topic, signedTxObject };
}
