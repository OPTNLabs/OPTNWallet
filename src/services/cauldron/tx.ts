import {
  bigIntToCompactUint,
  cashAddressToLockingBytecode,
  compactUintPrefixToLength,
  hexToBin,
  type Input,
  type Output,
  type TransactionTemplateFixed,
} from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';

import KeyService from '../KeyService';
import TransactionService from '../TransactionService';
import { OptnWizardWalletAdapter } from '../wizardconnect/OptnWizardWalletAdapter';
import { TOKEN_OUTPUT_SATS, DUST } from '../../utils/constants';
import { parseSatoshis } from '../../utils/binary';
import type { ContractInfo } from '../../types/wcInterfaces';
import type { Token, UTXO } from '../../types/types';
import {
  buildCauldronPoolV0ExchangeUnlockingBytecode,
} from './script';
import {
  CAULDRON_NATIVE_BCH,
  type CauldronPoolTrade,
  type CauldronTokenId,
} from './types';

type WalletPathName = 'receive' | 'change' | 'defi';

export type ResolvedCauldronFundingInput = {
  utxo: UTXO;
  lockingBytecode: Uint8Array;
  pathName: WalletPathName;
  addressIndex: number;
};

export type CauldronSettlementOutput = {
  lockingBytecode: Uint8Array;
  valueSatoshis: bigint;
  token?: {
    amount: bigint;
    category: Uint8Array;
  };
};

export type BuiltCauldronTradeRequest = {
  signRequest: SignTransactionRequest;
  sourceOutputs: Array<Input & Output & ContractInfo>;
  settlementOutputs: CauldronSettlementOutput[];
  estimatedFeeSatoshis: bigint;
  supplyTokenId: CauldronTokenId;
  demandTokenId: CauldronTokenId;
  totalSupply: bigint;
  totalDemand: bigint;
  walletInputs: ResolvedCauldronFundingInput[];
};

function toWalletPathName(changeIndex: number): WalletPathName {
  if (changeIndex === 0) return 'receive';
  if (changeIndex === 1) return 'change';
  if (changeIndex === 7) return 'defi';
  throw new Error(`Unsupported wallet branch for Cauldron signing: ${changeIndex}`);
}

function tokenToLibauthToken(token: Token | null | undefined) {
  if (!token?.category) return undefined;
  return {
    amount: parseSatoshis(token.amount),
    category: hexToBin(String(token.category)),
    nft: token.nft
      ? {
          capability: token.nft.capability,
          commitment: hexToBin(token.nft.commitment),
        }
      : undefined,
  };
}

function outputSizeBytes(output: CauldronSettlementOutput): number {
  const lockingLength = output.lockingBytecode.length;
  const tokenLength = output.token
    ? 34 +
      compactUintPrefixToLength(
        bigIntToCompactUint(output.token.amount)[0] as number
      )
    : 0;

  return (
    8 +
    compactUintPrefixToLength(bigIntToCompactUint(BigInt(lockingLength))[0] as number) +
    lockingLength +
    tokenLength
  );
}

function estimateCauldronTradeTxSize(
  poolTrades: CauldronPoolTrade[],
  walletInputs: ResolvedCauldronFundingInput[],
  settlementOutputs: CauldronSettlementOutput[]
): number {
  const poolIoSize = poolTrades.reduce((sum, trade) => {
    const nextTokenAmount =
      trade.pool.output.tokenAmount +
      (trade.supplyTokenId === CAULDRON_NATIVE_BCH ? -trade.demand : trade.supply);
    const outputSize =
      8 +
      1 +
      trade.pool.output.lockingBytecode.length +
      34 +
      compactUintPrefixToLength(bigIntToCompactUint(nextTokenAmount)[0] as number);
    const inputSize = 32 + 4 + 1 + 69 + 4;
    return sum + inputSize + outputSize;
  }, 0);

  const p2pkhInputSize = 32 + 4 + 1 + (1 + 65 + 1 + 33) + 4;
  const walletInputBytes = walletInputs.length * p2pkhInputSize;
  const outputsBytes = settlementOutputs.reduce(
    (sum, output) => sum + outputSizeBytes(output),
    0
  );

  const totalInputCount = poolTrades.length + walletInputs.length;
  const totalOutputCount = poolTrades.length + settlementOutputs.length;

  return (
    4 +
    compactUintPrefixToLength(bigIntToCompactUint(BigInt(totalInputCount))[0] as number) +
    compactUintPrefixToLength(bigIntToCompactUint(BigInt(totalOutputCount))[0] as number) +
    poolIoSize +
    walletInputBytes +
    outputsBytes +
    4
  );
}

function buildCashAddressOutput(
  address: string,
  valueSatoshis: bigint,
  token?: { amount: bigint; categoryHex: string }
): CauldronSettlementOutput {
  const result = cashAddressToLockingBytecode(address);
  if (typeof result === 'string') {
    throw new Error(`Invalid cash address for Cauldron output: ${address}`);
  }

  return {
    lockingBytecode: result.bytecode,
    valueSatoshis,
    token: token
      ? {
          amount: token.amount,
          category: hexToBin(token.categoryHex),
        }
      : undefined,
  };
}

function buildPoolSourceOutput(trade: CauldronPoolTrade): Input & Output & ContractInfo {
  return {
    outpointIndex: trade.pool.outputIndex,
    outpointTransactionHash: hexToBin(trade.pool.txHash),
    sequenceNumber: 0,
    unlockingBytecode: buildCauldronPoolV0ExchangeUnlockingBytecode(
      trade.pool.parameters
    ),
    lockingBytecode: trade.pool.output.lockingBytecode,
    valueSatoshis: trade.pool.output.amountSatoshis,
    token: {
      amount: trade.pool.output.tokenAmount,
      category: hexToBin(trade.pool.output.tokenCategory),
    },
  };
}

function buildPoolOutput(trade: CauldronPoolTrade): CauldronSettlementOutput {
  return {
    lockingBytecode: trade.pool.output.lockingBytecode,
    valueSatoshis:
      trade.pool.output.amountSatoshis +
      (trade.supplyTokenId === CAULDRON_NATIVE_BCH ? trade.supply : -trade.demand),
    token: {
      amount:
        trade.pool.output.tokenAmount +
        (trade.supplyTokenId === CAULDRON_NATIVE_BCH ? -trade.demand : trade.supply),
      category: hexToBin(trade.pool.output.tokenCategory),
    },
  };
}

function buildSettlementOutputs(args: {
  demandTokenId: CauldronTokenId;
  totalDemand: bigint;
  totalSupply: bigint;
  totalWalletBch: bigint;
  totalWalletTokenSupply: bigint;
  recipientAddress: string;
  changeAddress: string;
  tokenChangeAddress?: string;
  tokenChangeCategoryHex?: string;
  feeSatoshis: bigint;
  tokenOutputSatoshis: bigint;
}): CauldronSettlementOutput[] {
  const {
    demandTokenId,
    totalDemand,
    totalSupply,
    totalWalletBch,
    totalWalletTokenSupply,
    recipientAddress,
    changeAddress,
    tokenChangeAddress,
    tokenChangeCategoryHex,
    feeSatoshis,
    tokenOutputSatoshis,
  } = args;

  const outputs: CauldronSettlementOutput[] = [];

  if (demandTokenId === CAULDRON_NATIVE_BCH) {
    outputs.push(buildCashAddressOutput(recipientAddress, totalDemand));

    const tokenChange = totalWalletTokenSupply - totalSupply;
    if (tokenChange < 0n) {
      throw new Error('Insufficient token funding for Cauldron trade');
    }

    let bchChange = totalWalletBch - feeSatoshis;
    if (tokenChange > 0n) {
      if (!tokenChangeCategoryHex) {
        throw new Error('Missing token category for Cauldron token change output');
      }
      const tokenChangeTarget = tokenChangeAddress ?? changeAddress;
      outputs.push(
        buildCashAddressOutput(tokenChangeTarget, tokenOutputSatoshis, {
          amount: tokenChange,
          categoryHex: tokenChangeCategoryHex,
        })
      );
      bchChange -= tokenOutputSatoshis;
    }

    if (bchChange >= BigInt(DUST)) {
      outputs.push(buildCashAddressOutput(changeAddress, bchChange));
    } else if (bchChange < 0n) {
      throw new Error('Insufficient BCH funding for Cauldron fee/change backing');
    }
    return outputs;
  }

  outputs.push(
    buildCashAddressOutput(recipientAddress, tokenOutputSatoshis, {
      amount: totalDemand,
      categoryHex: demandTokenId,
    })
  );

  const bchChange = totalWalletBch - totalSupply - tokenOutputSatoshis - feeSatoshis;
  if (bchChange >= BigInt(DUST)) {
    outputs.push(buildCashAddressOutput(changeAddress, bchChange));
  } else if (bchChange < 0n) {
    throw new Error('Insufficient BCH funding for Cauldron trade');
  }

  return outputs;
}

function validateTradeDirection(poolTrades: CauldronPoolTrade[]): {
  supplyTokenId: CauldronTokenId;
  demandTokenId: CauldronTokenId;
  totalSupply: bigint;
  totalDemand: bigint;
} {
  if (poolTrades.length === 0) {
    throw new Error('At least one Cauldron pool trade is required');
  }

  const { supplyTokenId, demandTokenId } = poolTrades[0];
  for (const trade of poolTrades) {
    if (
      trade.supplyTokenId !== supplyTokenId ||
      trade.demandTokenId !== demandTokenId
    ) {
      throw new Error('All Cauldron pool trades must share the same direction');
    }
  }

  return {
    supplyTokenId,
    demandTokenId,
    totalSupply: poolTrades.reduce((sum, trade) => sum + trade.supply, 0n),
    totalDemand: poolTrades.reduce((sum, trade) => sum + trade.demand, 0n),
  };
}

export async function resolveCauldronFundingInputs(
  walletId: number,
  utxos: UTXO[]
): Promise<ResolvedCauldronFundingInput[]> {
  const keys = await KeyService.retrieveKeys(walletId);
  const keyByAddress = new Map(
    keys.flatMap((key) => [
      [key.address, key],
      [key.tokenAddress, key],
    ])
  );

  return utxos.map((utxo) => {
    const key =
      keyByAddress.get(utxo.address) ??
      (utxo.tokenAddress ? keyByAddress.get(utxo.tokenAddress) : undefined);
    if (!key) {
      throw new Error(`Unable to resolve wallet path for funding input ${utxo.tx_hash}:${utxo.tx_pos}`);
    }

    const lockingResult = cashAddressToLockingBytecode(utxo.address);
    if (typeof lockingResult === 'string') {
      throw new Error(`Invalid wallet funding address: ${utxo.address}`);
    }

    return {
      utxo,
      lockingBytecode: lockingResult.bytecode,
      pathName: toWalletPathName(key.changeIndex),
      addressIndex: key.addressIndex,
    };
  });
}

export function buildCauldronTradeRequest(params: {
  poolTrades: CauldronPoolTrade[];
  walletInputs: ResolvedCauldronFundingInput[];
  recipientAddress: string;
  changeAddress: string;
  tokenChangeAddress?: string;
  feeRateSatsPerByte?: bigint | number;
  broadcast?: boolean;
  userPrompt?: string;
  sequence?: number;
  tokenOutputSatoshis?: bigint;
}): BuiltCauldronTradeRequest {
  const {
    poolTrades,
    walletInputs,
    recipientAddress,
    changeAddress,
    tokenChangeAddress,
    userPrompt,
  } = params;
  const feeRateSatsPerByte =
    typeof params.feeRateSatsPerByte === 'bigint'
      ? params.feeRateSatsPerByte
      : BigInt(params.feeRateSatsPerByte ?? 1);
  const tokenOutputSatoshis = params.tokenOutputSatoshis ?? BigInt(TOKEN_OUTPUT_SATS);
  const { supplyTokenId, demandTokenId, totalSupply, totalDemand } =
    validateTradeDirection(poolTrades);

  const totalWalletBch = walletInputs.reduce(
    (sum, input) => sum + parseSatoshis(input.utxo.amount ?? input.utxo.value),
    0n
  );
  const totalWalletTokenSupply = walletInputs.reduce((sum, input) => {
    const token = input.utxo.token;
    if (!token) return sum;
    return sum + parseSatoshis(token.amount);
  }, 0n);

  if (supplyTokenId === CAULDRON_NATIVE_BCH) {
    if (walletInputs.some((input) => input.utxo.token)) {
      throw new Error('BCH-to-token Cauldron trades expect BCH-only funding inputs');
    }
  } else {
    const matchingTokenTotal = walletInputs.reduce((sum, input) => {
      return input.utxo.token?.category === supplyTokenId
        ? sum + parseSatoshis(input.utxo.token.amount)
        : sum;
    }, 0n);
    if (matchingTokenTotal < totalSupply) {
      throw new Error('Token-to-BCH Cauldron trades are missing token funding');
    }
    if (walletInputs.some((input) => input.utxo.token?.nft)) {
      throw new Error('NFT-bearing UTXOs are not supported for Cauldron funding');
    }
  }

  const buildOutputsForFee = (feeSatoshis: bigint): CauldronSettlementOutput[] =>
    buildSettlementOutputs({
      demandTokenId,
      totalDemand,
      totalSupply,
      totalWalletBch,
      totalWalletTokenSupply,
      recipientAddress,
      changeAddress,
      tokenChangeAddress,
      tokenChangeCategoryHex:
        supplyTokenId === CAULDRON_NATIVE_BCH ? undefined : supplyTokenId,
      feeSatoshis,
      tokenOutputSatoshis,
    });

  let settlementOutputs = buildOutputsForFee(0n);
  let estimatedFeeSatoshis = BigInt(
    estimateCauldronTradeTxSize(poolTrades, walletInputs, settlementOutputs)
  ) * feeRateSatsPerByte;

  for (let i = 0; i < 3; i += 1) {
    settlementOutputs = buildOutputsForFee(estimatedFeeSatoshis);
    const nextFee =
      BigInt(
        estimateCauldronTradeTxSize(poolTrades, walletInputs, settlementOutputs)
      ) * feeRateSatsPerByte;
    if (nextFee === estimatedFeeSatoshis) break;
    estimatedFeeSatoshis = nextFee;
  }

  const sourceOutputs: Array<Input & Output & ContractInfo> = [
    ...poolTrades.map((trade) => buildPoolSourceOutput(trade)),
    ...walletInputs.map((input) => ({
      outpointIndex: input.utxo.tx_pos,
      outpointTransactionHash: hexToBin(input.utxo.tx_hash),
      sequenceNumber: 0,
      unlockingBytecode: new Uint8Array(),
      lockingBytecode: input.lockingBytecode,
      valueSatoshis: parseSatoshis(input.utxo.amount ?? input.utxo.value),
      token: tokenToLibauthToken(input.utxo.token),
      address: input.utxo.address,
    })),
  ];

  const transaction: TransactionTemplateFixed<any> = {
    version: 2,
    locktime: 0,
    inputs: [
      ...poolTrades.map((trade) => ({
        outpointIndex: trade.pool.outputIndex,
        outpointTransactionHash: hexToBin(trade.pool.txHash),
        sequenceNumber: 0,
        unlockingBytecode: buildCauldronPoolV0ExchangeUnlockingBytecode(
          trade.pool.parameters
        ),
      })),
      ...walletInputs.map((input) => ({
        outpointIndex: input.utxo.tx_pos,
        outpointTransactionHash: hexToBin(input.utxo.tx_hash),
        sequenceNumber: 0,
        unlockingBytecode: new Uint8Array(),
      })),
    ],
    outputs: [
      ...poolTrades.map((trade) => buildPoolOutput(trade)),
      ...settlementOutputs,
    ],
  };

  const signRequest = {
    action: 'sign_transaction_request',
    time: Date.now(),
    sequence: params.sequence ?? 0,
    inputPaths: walletInputs.map((input, offset) => [
      poolTrades.length + offset,
      input.pathName,
      input.addressIndex,
    ]),
    transaction: {
      transaction,
      sourceOutputs,
      broadcast: params.broadcast ?? false,
      userPrompt: userPrompt ?? 'Cauldron swap',
    },
  } as unknown as SignTransactionRequest;

  return {
    signRequest,
    sourceOutputs,
    settlementOutputs,
    estimatedFeeSatoshis,
    supplyTokenId,
    demandTokenId,
    totalSupply,
    totalDemand,
    walletInputs,
  };
}

export async function signCauldronTradeRequest(
  walletId: number,
  built: BuiltCauldronTradeRequest
): Promise<string> {
  const adapter = await OptnWizardWalletAdapter.create(walletId);
  const result = await adapter.signTransaction(built.signRequest);
  return result.signedTransaction;
}

export async function signAndBroadcastCauldronTradeRequest(
  walletId: number,
  built: BuiltCauldronTradeRequest,
  options?: {
    sourceLabel?: string | null;
    recipientSummary?: string | null;
    amountSummary?: string | null;
    userPrompt?: string | null;
  }
) {
  const signedTransaction = await signCauldronTradeRequest(walletId, built);
  return TransactionService.sendTransaction(
    signedTransaction,
    built.walletInputs.map((input) => input.utxo),
    {
      source: 'cauldron',
      sourceLabel: options?.sourceLabel ?? 'Cauldron',
      recipientSummary: options?.recipientSummary ?? null,
      amountSummary: options?.amountSummary ?? null,
      userPrompt: options?.userPrompt ?? built.signRequest.transaction.userPrompt ?? null,
    }
  );
}
