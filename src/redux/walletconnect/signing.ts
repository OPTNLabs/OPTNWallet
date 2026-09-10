import {
  encodeTransaction,
  sha256,
  binToHex,
  hexToBin,
  type TransactionCommon,
  type Input,
  type Output,
  CompilationContextBCH,
  lockingBytecodeToCashAddress,
  stringify,
} from '@bitauth/libauth';
import type { WalletKitTypes } from '@reown/walletkit';
import type { RootState } from '../../state/store';
import { Network } from '../../state/slices/networkSlice';
import KeyService from '../../services/KeyService';
import { getBchAddressPath } from '../../services/HdWalletService';
import { parseExtendedJson } from '../../utils/parseExtendedJson';
import type { ContractInfo } from '../../types/wcInterfaces';
import TransactionService from '../../services/TransactionService';
import { ensureUint8Array } from '../../utils/binary';
import { PREFIX } from '../../utils/constants';
import { normalizeWalletAddressCandidate } from './helpers';
import { zeroize } from '../../utils/secureMemory';
import {
  trezorSignTransaction,
  pathToAddressN,
  type TrezorInput,
  type TrezorOutput,
} from '../../services/hardware/TrezorService';
import {
  ledgerSignTransaction,
  type LedgerInput,
  type LedgerOutput,
} from '../../services/hardware/LedgerService';
import getElectrumAdapter from '../../services/ElectrumAdapter';
import {
  CONNECT_ALL_OUTPUTS_ALL_UTXOS,
  connectorPublicKey,
  signConnectorInput,
  signConnectorP2pkh,
} from '../../services/connect/ConnectSigningCore';

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
  const request = parseExtendedJson(stringify(rawParams));
  const txDetails = request.transaction as TransactionCommon;
  const sourceOutputs = request.sourceOutputs as (Input &
    Output &
    ContractInfo)[];
  if (
    !txDetails ||
    !Array.isArray(txDetails.inputs) ||
    !Array.isArray(sourceOutputs) ||
    sourceOutputs.length !== txDetails.inputs.length
  ) {
    throw new Error('Malformed WalletConnect transaction request');
  }

  const walletId = state.wallet_id.currentWalletId!;
  const keys = await KeyService.retrieveKeys(walletId);
  if (!keys.length) throw new Error('No key available');
  const networkPrefix = PREFIX[state.network.currentNetwork];

  // Hardware wallet branch — device signs instead of software key
  const hwState = (state as unknown as Record<string, unknown>)
    .hardwareWallet as { type: string; connected: boolean } | undefined;
  if (
    hwState?.connected &&
    (hwState.type === 'trezor' || hwState.type === 'ledger')
  ) {
    const addressToKey = new Map(keys.map((k) => [k.address, k]));
    const signed = await signWalletConnectWithHardware({
      txDetails,
      sourceOutputs,
      addressToKey,
      networkPrefix,
      network: state.network.currentNetwork,
      accountPath: state.wallet_id.derivationPath || undefined,
      hwType: hwState.type as 'trezor' | 'ledger',
    });
    const rawBytes = hexToBin(signed);
    const signedTransactionHash = binToHex(
      sha256.hash(sha256.hash(rawBytes)).reverse()
    );
    return {
      id,
      topic,
      signedTxObject: { signedTransaction: signed, signedTransactionHash },
    };
  }
  const keyAddressSet = new Set(
    keys
      .map((k) => normalizeWalletAddressCandidate(k.address, networkPrefix))
      .filter((address): address is string => !!address)
  );
  const rawRequestRecord =
    request && typeof request === 'object'
      ? (request as Record<string, unknown>)
      : {};
  const requestedSignerAddress = [
    rawRequestRecord.account,
    rawRequestRecord.address,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((candidate) =>
      normalizeWalletAddressCandidate(candidate, networkPrefix)
    )
    .find(
      (candidate): candidate is string =>
        !!candidate && keyAddressSet.has(candidate)
    );

  const defaultSignerAddress = requestedSignerAddress ?? keys[0].address;
  const defaultPrivateKey = await KeyService.fetchAddressPrivateKey(
    defaultSignerAddress,
    'spend'
  );
  if (!defaultPrivateKey) throw new Error('Private key not found');
  const usedKeys = new Set<Uint8Array>([defaultPrivateKey]);

  try {
    const txTemplate = {
      ...txDetails,
      inputs: txDetails.inputs.map((input) => ({ ...input })),
    };
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

      if (
        (!sourceAddress || !keyAddressSet.has(sourceAddress)) &&
        !utxo.contract?.artifact?.contractName &&
        input.unlockingBytecode instanceof Uint8Array &&
        input.unlockingBytecode.length > 0
      ) {
        // Keep another participant's already signed input byte-for-byte.
        continue;
      }

      const signerKey =
        sourceAddress && keyAddressSet.has(sourceAddress)
          ? await KeyService.fetchAddressPrivateKey(sourceAddress, 'spend')
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
          const context = {
            inputIndex: i,
            sourceOutputs,
            transaction: txDetails,
          } as CompilationContextBCH;
          if (!utxo.contract.redeemScript) {
            throw new Error('Missing WalletConnect covenant redeem script');
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
      } else {
        input.unlockingBytecode = signConnectorP2pkh(
          {
            inputIndex: i,
            sourceOutputs,
            transaction: txTemplate,
          },
          signerKey
        );
      }
    }

    const rawSigned = encodeTransaction(txTemplate);
    const rawSignedHex = binToHex(rawSigned);
    const txid = binToHex(sha256.hash(sha256.hash(rawSigned)).reverse());

    const signedTxObject: SignedTxObject = {
      signedTransaction: rawSignedHex,
      signedTransactionHash: txid,
    };

    if (request.broadcast) {
      try {
        const sessionMeta =
          state.walletconnect.activeSessions?.[topic]?.peer?.metadata;
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
              typeof request.userPrompt === 'string'
                ? request.userPrompt
                : null,
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

type KeyRecord = {
  address: string;
  changeIndex: number;
  addressIndex: number;
};

type CashAddrPrefix = Parameters<
  typeof lockingBytecodeToCashAddress
>[0]['prefix'];

async function signWalletConnectWithHardware({
  txDetails,
  sourceOutputs,
  addressToKey,
  networkPrefix,
  network,
  accountPath,
  hwType,
}: {
  txDetails: TransactionCommon;
  sourceOutputs: (Input & Output & ContractInfo)[];
  addressToKey: Map<string, KeyRecord>;
  networkPrefix: string;
  network: Network;
  accountPath?: string;
  hwType: 'trezor' | 'ledger';
}): Promise<string> {
  const typedPrefix = networkPrefix as unknown as CashAddrPrefix;

  function lcbToAddress(locking: Uint8Array): string {
    const r = lockingBytecodeToCashAddress({
      prefix: typedPrefix,
      bytecode: locking,
    });
    return typeof r === 'string' ? r : (r as { address: string }).address;
  }

  function inputAddress(utxo: Input & Output & ContractInfo): string | null {
    const typed = utxo as { address?: unknown; lockingBytecode?: unknown };
    if (typeof typed.address === 'string') return typed.address;
    if (!typed.lockingBytecode) return null;
    return lcbToAddress(ensureUint8Array(typed.lockingBytecode));
  }

  if (hwType === 'trezor') {
    const trezorInputs: TrezorInput[] = txDetails.inputs.map((inp, i) => {
      const address = inputAddress(sourceOutputs[i]);
      const keyRecord = address ? addressToKey.get(address) : null;
      const bip44 = keyRecord
        ? getBchAddressPath(
            network,
            0,
            keyRecord.changeIndex,
            keyRecord.addressIndex,
            accountPath
          )
        : getBchAddressPath(network, 0, 0, 0, accountPath);
      return {
        address_n: pathToAddressN(bip44),
        prev_hash: binToHex(
          Uint8Array.from(inp.outpointTransactionHash).reverse()
        ),
        prev_index: inp.outpointIndex,
        amount: String(sourceOutputs[i]?.valueSatoshis ?? 0n),
        script_type: 'SPENDADDRESS',
      };
    });

    const trezorOutputs: TrezorOutput[] = txDetails.outputs.map((out) => ({
      address: lcbToAddress(ensureUint8Array(out.lockingBytecode)),
      amount: String(out.valueSatoshis),
      script_type: 'PAYTOADDRESS',
    }));

    const result = await trezorSignTransaction(trezorInputs, trezorOutputs);
    return result.serializedTx;
  }

  // Ledger path
  const adapter = getElectrumAdapter();
  const ledgerInputs: LedgerInput[] = await Promise.all(
    txDetails.inputs.map(async (inp, i) => {
      const address = inputAddress(sourceOutputs[i]);
      const keyRecord = address ? addressToKey.get(address) : null;
      const bip44 = keyRecord
        ? getBchAddressPath(
            network,
            0,
            keyRecord.changeIndex,
            keyRecord.addressIndex,
            accountPath
          ).replace(/^m\//, '')
        : getBchAddressPath(network, 0, 0, 0, accountPath).replace(/^m\//, '');
      const txid = binToHex(
        Uint8Array.from(inp.outpointTransactionHash).reverse()
      );
      const prevTxHex = (await adapter.request(
        'blockchain.transaction.get',
        txid,
        false
      )) as string;
      return { path: bip44, prevTxHex, prevIndex: inp.outpointIndex };
    })
  );

  const ledgerOutputs: LedgerOutput[] = txDetails.outputs.map((out) => ({
    address: lcbToAddress(ensureUint8Array(out.lockingBytecode)),
    amountSatoshis: out.valueSatoshis,
  }));

  const result = await ledgerSignTransaction(ledgerInputs, ledgerOutputs);
  return result.serializedTx;
}
