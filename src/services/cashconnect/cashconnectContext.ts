import {
  binToHex,
  cashAddressToLockingBytecode,
  hexToBin,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBCH,
  type Output,
} from '@bitauth/libauth';
import type {
  ChangeTemplateDirective,
  SpendableUTXO,
} from '@cashconnect-js/core/templates';
import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';
import { Network } from '../../state/slices/networkSlice';
import { store } from '../../state/store';
import type { UTXO } from '../../types/types';
import { reservedOutpoints } from '../../platform/desktop/fusionRoundState';
import { deriveBchKeyMaterial } from '../HdWalletService';
import { zeroize } from '../../utils/secureMemory';
import KeyService from '../KeyService';

type KeyRow = {
  address: string;
  accountIndex: number;
  changeIndex: number;
  addressIndex: number;
};

type WalletSeed = {
  mnemonic: string;
  passphrase: string;
  network: Network;
  accountPath: string;
};

function asUtxoMap(): Record<string, UTXO[]> {
  return store.getState().utxos.utxos ?? {};
}

export function tokenFromUtxo(utxo: UTXO): Output['token'] | undefined {
  const token = utxo.token ?? utxo.token_data;
  if (!token?.category) return undefined;
  const out: NonNullable<Output['token']> = {
    amount: BigInt(token.amount ?? 0),
    category: hexToBin(String(token.category).replace(/^0x/i, '')),
  };
  if (token.nft) {
    out.nft = {
      capability: token.nft.capability || 'none',
      commitment: hexToBin(token.nft.commitment || ''),
    };
  }
  return out;
}

export function cashConnectKeyFreeData(): Record<string, never> {
  return {};
}

export function cashConnectChangeData(publicKey: Uint8Array) {
  return {
    bytecode: {
      'key.public_key': publicKey,
    },
  };
}

export async function getSpendableUTXOsForCashConnect(
  walletId: number
): Promise<SpendableUTXO[]> {
  // alpha.31 builds and signs before onExecuteAction. Keep the context
  // key-free so spend actions fail closed until a post-consent signer exists.
  const compiler = walletTemplateToCompilerBCH(walletTemplateP2pkhNonHd);
  const keys = (await KeyService.retrieveKeys(walletId)) as KeyRow[];
  const byAddress = new Map(keys.map((key) => [key.address, key]));
  const reserved = reservedOutpoints(walletId);
  const spendable: SpendableUTXO[] = [];
  const data = cashConnectKeyFreeData();

  for (const [address, utxos] of Object.entries(asUtxoMap())) {
    const key = byAddress.get(address);
    if (!key || !utxos?.length) continue;
    const locking = cashAddressToLockingBytecode(address);
    if (typeof locking === 'string') continue;
    for (const utxo of utxos) {
      const outpoint = `${utxo.tx_hash}:${utxo.tx_pos}`;
      if (reserved.has(outpoint)) continue;
      spendable.push({
        outpointTransactionHash: hexToBin(utxo.tx_hash),
        outpointIndex: utxo.tx_pos,
        sequenceNumber: 0,
        unlockingBytecode: {
          compiler,
          script: 'unlock',
          data,
        },
        sourceOutput: {
          lockingBytecode: locking.bytecode,
          valueSatoshis: BigInt(utxo.value ?? utxo.amount ?? 0),
          ...(tokenFromUtxo(utxo) ? { token: tokenFromUtxo(utxo) } : {}),
        },
      });
    }
  }
  return spendable;
}

export async function getChangeTemplateDirectiveForCashConnect(
  walletId: number,
  seed: WalletSeed
): Promise<ChangeTemplateDirective> {
  const keys = (await KeyService.retrieveKeys(walletId)) as KeyRow[];
  const change =
    keys.find((key) => key.changeIndex === 1) ??
    keys.find((key) => key.changeIndex === 0 && key.addressIndex === 0);
  if (!change) {
    throw new Error('No change address is available for CashConnect');
  }
  const material = await deriveBchKeyMaterial(
    seed.network,
    seed.mnemonic,
    seed.passphrase,
    change.accountIndex,
    change.changeIndex,
    change.addressIndex,
    seed.accountPath
  );
  if (!material) {
    throw new Error('No change address is available for CashConnect');
  }
  try {
    const compiler = walletTemplateToCompilerBCH(walletTemplateP2pkhNonHd);
    const data = cashConnectChangeData(material.publicKey);
    return {
      lock: { compiler, data, script: 'lock' },
      unlock: { compiler, data, script: 'unlock' },
      fee: 1000n,
    };
  } finally {
    zeroize(material.privateKey);
  }
}

export async function getSourceOutputForCashConnect(
  outpointTransactionHash: Uint8Array,
  outpointIndex: number
): Promise<Output> {
  const txid = binToHex(outpointTransactionHash);
  const server = ElectrumServer();
  const raw = (await server.request(
    'blockchain.transaction.get',
    txid,
    true
  )) as {
    vout?: Array<{
      value?: number;
      scriptPubKey?: { hex?: string };
      tokenData?: {
        category: string;
        amount: string | number;
        nft?: { capability?: string; commitment?: string };
      };
    }>;
  };
  const vout = raw?.vout?.[outpointIndex];
  if (!vout?.scriptPubKey?.hex) {
    throw new Error(`CashConnect source output missing: ${txid}:${outpointIndex}`);
  }
  const output: Output = {
    valueSatoshis: BigInt(Math.round(Number(vout.value ?? 0) * 100_000_000)),
    lockingBytecode: hexToBin(vout.scriptPubKey.hex),
  };
  if (vout.tokenData) {
    output.token = {
      category: hexToBin(vout.tokenData.category),
      amount: BigInt(vout.tokenData.amount),
      ...(vout.tokenData.nft
        ? {
            nft: {
              capability: (vout.tokenData.nft.capability || 'none') as
                | 'none'
                | 'mutable'
                | 'minting',
              commitment: hexToBin(vout.tokenData.nft.commitment || ''),
            },
          }
        : {}),
    };
  }
  return output;
}
