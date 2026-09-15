import {
  binToHex,
  bigIntToCompactUint,
  cashAddressToLockingBytecode,
  compactUintPrefixToLength,
  createVirtualMachineBCH,
  decodeTransaction,
  hexToBin,
  hash256,
  type Input,
  type Output,
  type TransactionTemplateFixed,
} from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';

import KeyService from '../KeyService';
import TransactionService from '../TransactionService';
import { OptnWizardWalletAdapter } from '../wizardconnect/OptnWizardWalletAdapter';
import { getBchCoinType } from '../HdWalletService';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { store } from '../../state/store';
import {
  encodeUnsignedPsbt,
  SIGHASH_ALL_FORKID_ANYONECANPAY,
  type PsbtInputSpec,
  type PsbtOutputSpec,
  type PsbtTokenSpec,
} from '../psbt/psbtBch';
import { fetchParentTransactions } from '../psbt/parentTransactions';
import { TOKEN_OUTPUT_SATS, DUST } from '../../utils/constants';
import { ensureUint8Array, parseSatoshis } from '../../utils/binary';
import { derivePublicKeyHash } from '../../utils/derivePublicKeyHash';
import type { ContractInfo } from '../../types/wcInterfaces';
import type { Token, UTXO } from '../../types/types';
import {
  buildCauldronPoolV0ExchangeUnlockingBytecode,
  buildCauldronPoolV0LockingBytecode,
  buildCauldronPoolV0RedeemScript,
  buildCauldronPoolV0WithdrawUnlockingBytecodePlaceholder,
} from './script';
import {
  CAULDRON_NATIVE_BCH,
  type CauldronPool,
  type CauldronPoolTrade,
  type CauldronTokenId,
} from './types';

type WalletPathName = 'receive' | 'change' | 'defi';

export type ResolvedCauldronFundingInput = {
  utxo: UTXO;
  lockingBytecode: Uint8Array;
  pathName: WalletPathName;
  addressIndex: number;
  /** Public metadata used when materializing the final buyer PSBT. */
  publicKey?: Uint8Array;
  accountIndex?: number;
  coinType?: number;
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
  changeAddress: string;
  tokenChangeAddress?: string;
};

export type BuiltCauldronMerchantPaymentRequest = BuiltCauldronTradeRequest & {
  paymentKind: 'merchant';
  merchantPaymentMode: 'cauldron' | 'direct';
  merchantOutputIndexes: number[];
  merchantPaymentTerms: CauldronMerchantPaymentTerms;
};

export type CauldronMerchantPaymentTerms = {
  incomingAsset: 'bch' | 'token';
  incomingTokenCategory?: string;
  incomingAmountAtomic: bigint;
  directIncomingAmountAtomic: bigint;
  merchantBchAmountSatoshis: bigint;
  merchantTokenAmountAtomic: bigint;
};

export type BuiltCauldronPoolDepositRequest = {
  signRequest: SignTransactionRequest;
  sourceOutputs: Array<Input & Output & ContractInfo>;
  poolOutput: CauldronSettlementOutput;
  settlementOutputs: CauldronSettlementOutput[];
  estimatedFeeSatoshis: bigint;
  walletInputs: ResolvedCauldronFundingInput[];
  withdrawPublicKeyHash: Uint8Array;
};

export type BuiltCauldronPoolWithdrawRequest = {
  signRequest: SignTransactionRequest;
  sourceOutputs: Array<Input & Output & ContractInfo>;
  settlementOutputs: CauldronSettlementOutput[];
  estimatedFeeSatoshis: bigint;
  ownerInput: ResolvedCauldronFundingInput;
  pool: CauldronPool;
};

// BCH P2PKH inputs use a 65-byte Schnorr signature including the sighash byte
// and a 33-byte compressed public key. Keep this aligned with the serialized
// transaction so a 1 sat/byte target does not become an unintended surcharge.
const P2PKH_INPUT_SIZE_BYTES = 32 + 4 + 1 + (1 + 65 + 1 + 33) + 4;

/**
 * Cauldron swaps target the BCH network's 1 sat/byte relay floor. Callers may
 * request a higher rate, but never a lower one.
 */
export const CAULDRON_TARGET_FEE_RATE_SATS_PER_BYTE = 1n;

function normalizeCauldronFeeRate(
  feeRateSatsPerByte?: bigint | number
): bigint {
  const requestedRate =
    typeof feeRateSatsPerByte === 'bigint'
      ? feeRateSatsPerByte
      : BigInt(feeRateSatsPerByte ?? CAULDRON_TARGET_FEE_RATE_SATS_PER_BYTE);
  return requestedRate < CAULDRON_TARGET_FEE_RATE_SATS_PER_BYTE
    ? CAULDRON_TARGET_FEE_RATE_SATS_PER_BYTE
    : requestedRate;
}

function maxBigInt(left: bigint, right: bigint) {
  return left > right ? left : right;
}

export function calculateSignedTransactionFeeSatoshis(
  signedTransactionHex: string,
  sourceOutputs: Array<Input & Output & ContractInfo>
) {
  const decoded = decodeTransaction(hexToBin(signedTransactionHex));
  if (typeof decoded === 'string') {
    throw new Error(`Unable to decode signed Cauldron transaction: ${decoded}`);
  }

  const totalInputValue = sourceOutputs.reduce(
    (sum, output) => sum + output.valueSatoshis,
    0n
  );
  const totalOutputValue = decoded.outputs.reduce(
    (sum, output) => sum + output.valueSatoshis,
    0n
  );
  const actualFee = totalInputValue - totalOutputValue;

  if (actualFee < 0n) {
    throw new Error(
      'Signed Cauldron transaction output value exceeds its inputs.'
    );
  }

  return {
    actualFeeSatoshis: actualFee,
    transactionSizeBytes: BigInt(hexToBin(signedTransactionHex).length),
  };
}

export function assertSignedTransactionFeeSufficiency(args: {
  signedTransactionHex: string;
  sourceOutputs: Array<Input & Output & ContractInfo>;
  estimatedFeeSatoshis: bigint;
  feeRateSatsPerByte?: bigint;
  transactionLabel?: string;
}) {
  const {
    signedTransactionHex,
    sourceOutputs,
    estimatedFeeSatoshis,
    feeRateSatsPerByte = CAULDRON_TARGET_FEE_RATE_SATS_PER_BYTE,
    transactionLabel = 'Cauldron transaction',
  } = args;
  const { actualFeeSatoshis, transactionSizeBytes } =
    calculateSignedTransactionFeeSatoshis(signedTransactionHex, sourceOutputs);
  const minimumRelayFeeSatoshis =
    transactionSizeBytes * normalizeCauldronFeeRate(feeRateSatsPerByte);
  const requiredFeeSatoshis = maxBigInt(
    estimatedFeeSatoshis,
    minimumRelayFeeSatoshis
  );

  if (actualFeeSatoshis < requiredFeeSatoshis) {
    throw new Error(
      `${transactionLabel} fee is too low after signing. Required at least ${requiredFeeSatoshis} sats for ${transactionSizeBytes} bytes, but the signed transaction pays ${actualFeeSatoshis} sats.`
    );
  }
}

export function assertSignedTransactionCovenantValidity(args: {
  signedTransactionHex: string;
  sourceOutputs: Array<Input & Output & ContractInfo>;
  transactionLabel?: string;
}) {
  const {
    signedTransactionHex,
    sourceOutputs,
    transactionLabel = 'Cauldron transaction',
  } = args;
  const decoded = decodeTransaction(hexToBin(signedTransactionHex));
  if (typeof decoded === 'string') {
    throw new Error(
      `Unable to decode signed ${transactionLabel} for covenant verification: ${decoded}`
    );
  }

  const vm = createVirtualMachineBCH();
  const result = vm.verify({
    sourceOutputs,
    transaction: decoded,
  });
  if (typeof result === 'string') {
    const inputIndexMatch = result.match(/evaluating input index:?\s*(\d+)/i);
    const inputIndex = inputIndexMatch ? Number(inputIndexMatch[1]) : null;
    const failingSourceOutput =
      inputIndex !== null ? sourceOutputs[inputIndex] : undefined;
    const poolOutpointContext =
      inputIndex !== null &&
      Number.isInteger(inputIndex) &&
      failingSourceOutput?.contract?.artifact?.contractName === 'CauldronPoolV0'
        ? ` Failing pool outpoint ${binToHex(
            failingSourceOutput.outpointTransactionHash
          )}:${failingSourceOutput.outpointIndex}.`
        : '';
    const normalizedResult = /[.!?]$/.test(result) ? result : `${result}.`;
    throw new Error(
      `${transactionLabel} does not satisfy the on-chain covenant rules: ${normalizedResult}${poolOutpointContext}`
    );
  }
}

function toWalletPathName(changeIndex: number): WalletPathName {
  if (changeIndex === 0) return 'receive';
  if (changeIndex === 1) return 'change';
  if (changeIndex === 7) return 'defi';
  throw new Error(
    `Unsupported wallet branch for Cauldron signing: ${changeIndex}`
  );
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

function buildCauldronPoolContractInfo(
  withdrawPublicKeyHash: Uint8Array
): ContractInfo {
  return {
    contract: {
      abiFunction: {
        name: 'withdraw',
        covenant: false,
        inputs: [],
      },
      redeemScript: buildCauldronPoolV0RedeemScript({ withdrawPublicKeyHash }),
      artifact: {
        contractName: 'CauldronPoolV0',
      },
    },
  };
}

function normalizeWithdrawPublicKeyHash(
  withdrawPublicKeyHash:
    | Uint8Array
    | string
    | number[]
    | Record<string, unknown>,
  fallbackOwnerAddress?: string | null,
  fallbackOwnerPublicKeyHash?: string | null
): Uint8Array {
  const direct = ensureUint8Array(withdrawPublicKeyHash);
  if (direct.length === 20) return direct;

  if (fallbackOwnerAddress) {
    try {
      const derived = derivePublicKeyHash(fallbackOwnerAddress);
      if (derived.length === 20) return derived;
    } catch {
      // fall through
    }
  }

  if (fallbackOwnerPublicKeyHash) {
    const ownerHash = ensureUint8Array(fallbackOwnerPublicKeyHash);
    if (ownerHash.length === 20) return ownerHash;
  }

  return direct;
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
    compactUintPrefixToLength(
      bigIntToCompactUint(BigInt(lockingLength))[0] as number
    ) +
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
      (trade.supplyTokenId === CAULDRON_NATIVE_BCH
        ? -trade.demand
        : trade.supply);
    const outputSize =
      8 +
      1 +
      trade.pool.output.lockingBytecode.length +
      34 +
      compactUintPrefixToLength(
        bigIntToCompactUint(nextTokenAmount)[0] as number
      );
    const inputSize = 32 + 4 + 1 + 69 + 4;
    return sum + inputSize + outputSize;
  }, 0);

  const walletInputBytes = walletInputs.length * P2PKH_INPUT_SIZE_BYTES;
  const outputsBytes = settlementOutputs.reduce(
    (sum, output) => sum + outputSizeBytes(output),
    0
  );

  const totalInputCount = poolTrades.length + walletInputs.length;
  const totalOutputCount = poolTrades.length + settlementOutputs.length;

  return (
    4 +
    compactUintPrefixToLength(
      bigIntToCompactUint(BigInt(totalInputCount))[0] as number
    ) +
    compactUintPrefixToLength(
      bigIntToCompactUint(BigInt(totalOutputCount))[0] as number
    ) +
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

function buildPoolSourceOutput(
  trade: CauldronPoolTrade
): Input & Output & ContractInfo {
  const withdrawPublicKeyHash = normalizeWithdrawPublicKeyHash(
    trade.pool.parameters.withdrawPublicKeyHash,
    trade.pool.ownerAddress,
    trade.pool.ownerPublicKeyHash
  );
  return {
    outpointIndex: trade.pool.outputIndex,
    outpointTransactionHash: hexToBin(trade.pool.txHash),
    sequenceNumber: 0,
    unlockingBytecode: buildCauldronPoolV0ExchangeUnlockingBytecode({
      ...trade.pool.parameters,
      withdrawPublicKeyHash,
    }),
    lockingBytecode: trade.pool.output.lockingBytecode,
    valueSatoshis: trade.pool.output.amountSatoshis,
    token: {
      amount: trade.pool.output.tokenAmount,
      category: hexToBin(trade.pool.output.tokenCategory),
    },
    ...buildCauldronPoolContractInfo(withdrawPublicKeyHash),
  };
}

function normalizePoolTradeForTx(trade: CauldronPoolTrade): CauldronPoolTrade {
  const withdrawPublicKeyHash = normalizeWithdrawPublicKeyHash(
    trade.pool.parameters.withdrawPublicKeyHash,
    trade.pool.ownerAddress,
    trade.pool.ownerPublicKeyHash
  );
  return {
    ...trade,
    pool: {
      ...trade.pool,
      parameters: {
        ...trade.pool.parameters,
        withdrawPublicKeyHash,
      },
    },
  };
}

function buildPoolOutput(trade: CauldronPoolTrade): CauldronSettlementOutput {
  return {
    lockingBytecode: trade.pool.output.lockingBytecode,
    valueSatoshis:
      trade.pool.output.amountSatoshis +
      (trade.supplyTokenId === CAULDRON_NATIVE_BCH
        ? trade.supply
        : -trade.demand),
    token: {
      amount:
        trade.pool.output.tokenAmount +
        (trade.supplyTokenId === CAULDRON_NATIVE_BCH
          ? -trade.demand
          : trade.supply),
      category: hexToBin(trade.pool.output.tokenCategory),
    },
  };
}

function buildSettlementOutputs(args: {
  supplyTokenId: CauldronTokenId;
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
  merchantPaymentTerms?: CauldronMerchantPaymentTerms;
}): CauldronSettlementOutput[] {
  const {
    supplyTokenId,
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
    merchantPaymentTerms,
  } = args;

  const outputs: CauldronSettlementOutput[] = [];

  if (demandTokenId === CAULDRON_NATIVE_BCH) {
    outputs.push(buildCashAddressOutput(recipientAddress, totalDemand));

    const directTokenAmount =
      merchantPaymentTerms?.incomingAsset === 'token'
        ? merchantPaymentTerms.merchantTokenAmountAtomic
        : 0n;
    const tokenChange =
      totalWalletTokenSupply - totalSupply - directTokenAmount;
    if (tokenChange < 0n) {
      throw new Error('Insufficient token funding for Cauldron trade');
    }

    if (directTokenAmount > 0n) {
      outputs.push(
        buildCashAddressOutput(recipientAddress, tokenOutputSatoshis, {
          amount: directTokenAmount,
          categoryHex:
            merchantPaymentTerms?.incomingTokenCategory ?? supplyTokenId,
        })
      );
    }

    // Token amounts are atomic token units, not satoshis. The BCH attached to
    // token funding inputs remains wallet value and is only reduced by the
    // network fee, plus a token-output reserve when token change is needed.
    let bchChange = totalWalletBch - feeSatoshis;
    if (merchantPaymentTerms?.merchantBchAmountSatoshis) {
      bchChange -= merchantPaymentTerms.merchantBchAmountSatoshis;
    }
    if (tokenChange > 0n) {
      if (!tokenChangeCategoryHex) {
        throw new Error(
          'Missing token category for Cauldron token change output'
        );
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
    if (directTokenAmount > 0n) bchChange -= tokenOutputSatoshis;

    if (bchChange >= BigInt(DUST)) {
      outputs.push(buildCashAddressOutput(changeAddress, bchChange));
    } else if (bchChange < 0n) {
      throw new Error(
        'Insufficient BCH funding for Cauldron fee/change backing'
      );
    }
    return outputs;
  }

  outputs.push(
    buildCashAddressOutput(recipientAddress, tokenOutputSatoshis, {
      amount: totalDemand,
      categoryHex: demandTokenId,
    })
  );

  if (
    merchantPaymentTerms?.incomingAsset === 'bch' &&
    merchantPaymentTerms.merchantBchAmountSatoshis > 0n
  ) {
    outputs.push(
      buildCashAddressOutput(
        recipientAddress,
        merchantPaymentTerms.merchantBchAmountSatoshis
      )
    );
  }

  let bchChange =
    totalWalletBch -
    (supplyTokenId === CAULDRON_NATIVE_BCH ? totalSupply : 0n) -
    feeSatoshis;
  bchChange -= tokenOutputSatoshis;
  if (
    merchantPaymentTerms?.incomingAsset === 'bch' &&
    merchantPaymentTerms.merchantBchAmountSatoshis > 0n
  ) {
    bchChange -= merchantPaymentTerms.merchantBchAmountSatoshis;
  }
  const directTokenAmount =
    merchantPaymentTerms?.incomingAsset === 'token'
      ? merchantPaymentTerms.merchantTokenAmountAtomic
      : 0n;
  const tokenChange =
    supplyTokenId === CAULDRON_NATIVE_BCH
      ? 0n
      : totalWalletTokenSupply - totalSupply - directTokenAmount;
  if (tokenChange < 0n) {
    throw new Error('Insufficient token funding for Cauldron trade');
  }
  if (directTokenAmount > 0n) {
    outputs.push(
      buildCashAddressOutput(recipientAddress, tokenOutputSatoshis, {
        amount: directTokenAmount,
        categoryHex:
          merchantPaymentTerms?.incomingTokenCategory ?? supplyTokenId,
      })
    );
    bchChange -= tokenOutputSatoshis;
  }
  // The regular token-to-BCH path creates token change below. Keep its BCH
  // reserve separate from the fixed merchant token output above.
  if (tokenChange > 0n) {
    if (!tokenChangeCategoryHex) {
      throw new Error(
        'Missing token category for Cauldron token change output'
      );
    }
    outputs.push(
      buildCashAddressOutput(
        tokenChangeAddress ?? changeAddress,
        tokenOutputSatoshis,
        {
          amount: tokenChange,
          categoryHex: tokenChangeCategoryHex,
        }
      )
    );
    bchChange -= tokenOutputSatoshis;
  }
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

function buildWalletSourceOutput(
  input: ResolvedCauldronFundingInput
): Input & Output & ContractInfo {
  return {
    outpointIndex: input.utxo.tx_pos,
    outpointTransactionHash: hexToBin(input.utxo.tx_hash),
    sequenceNumber: 0,
    unlockingBytecode: new Uint8Array(),
    lockingBytecode: input.lockingBytecode,
    valueSatoshis: parseSatoshis(input.utxo.amount ?? input.utxo.value),
    token: tokenToLibauthToken(input.utxo.token),
  };
}

function buildWalletInput(input: ResolvedCauldronFundingInput): Input {
  return {
    outpointIndex: input.utxo.tx_pos,
    outpointTransactionHash: hexToBin(input.utxo.tx_hash),
    sequenceNumber: 0,
    unlockingBytecode: new Uint8Array(),
  };
}

function estimateFixedTransactionSize(args: {
  inputSizes: number[];
  outputs: CauldronSettlementOutput[];
}): number {
  const { inputSizes, outputs } = args;
  return (
    4 +
    compactUintPrefixToLength(
      bigIntToCompactUint(BigInt(inputSizes.length))[0] as number
    ) +
    compactUintPrefixToLength(
      bigIntToCompactUint(BigInt(outputs.length))[0] as number
    ) +
    inputSizes.reduce((sum, size) => sum + size, 0) +
    outputs.reduce((sum, output) => sum + outputSizeBytes(output), 0) +
    4
  );
}

function validateWalletTokenInputs(
  walletInputs: ResolvedCauldronFundingInput[],
  allowedTokenCategoryHex?: string
): {
  totalWalletBch: bigint;
  totalMatchingTokenSupply: bigint;
} {
  let totalWalletBch = 0n;
  let totalMatchingTokenSupply = 0n;

  for (const input of walletInputs) {
    totalWalletBch += parseSatoshis(input.utxo.amount ?? input.utxo.value);
    const token = input.utxo.token;
    if (!token) continue;

    if (token.nft) {
      throw new Error(
        'NFT-bearing UTXOs are not supported for Cauldron funding'
      );
    }
    if (
      !allowedTokenCategoryHex ||
      token.category !== allowedTokenCategoryHex
    ) {
      throw new Error(
        `Unexpected token funding input category for Cauldron transaction: ${token.category}`
      );
    }
    totalMatchingTokenSupply += parseSatoshis(token.amount);
  }

  return {
    totalWalletBch,
    totalMatchingTokenSupply,
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
      throw new Error(
        `Unable to resolve wallet path for funding input ${utxo.tx_hash}:${utxo.tx_pos}`
      );
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
      publicKey: key.publicKey,
      accountIndex: key.accountIndex,
      coinType: getBchCoinType(selectCurrentNetwork(store.getState())),
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
  minimumDemand?: bigint;
  merchantPaymentTerms?: CauldronMerchantPaymentTerms;
}): BuiltCauldronTradeRequest {
  const {
    poolTrades,
    walletInputs,
    recipientAddress,
    changeAddress,
    tokenChangeAddress,
    userPrompt,
  } = params;
  const feeRateSatsPerByte = normalizeCauldronFeeRate(
    params.feeRateSatsPerByte
  );
  const tokenOutputSatoshis =
    params.tokenOutputSatoshis ?? BigInt(TOKEN_OUTPUT_SATS);
  const normalizedPoolTrades = poolTrades.map(normalizePoolTradeForTx);
  const { supplyTokenId, demandTokenId, totalSupply, totalDemand } =
    validateTradeDirection(normalizedPoolTrades);

  if (
    params.minimumDemand != null &&
    (params.minimumDemand < 0n || totalDemand < params.minimumDemand)
  ) {
    throw new Error(
      `Cauldron trade output ${totalDemand} is below the required minimum ${params.minimumDemand}.`
    );
  }

  const { totalWalletBch, totalMatchingTokenSupply: totalWalletTokenSupply } =
    validateWalletTokenInputs(
      walletInputs,
      supplyTokenId === CAULDRON_NATIVE_BCH ? undefined : supplyTokenId
    );

  if (supplyTokenId === CAULDRON_NATIVE_BCH) {
    if (walletInputs.some((input) => input.utxo.token)) {
      throw new Error(
        'BCH-to-token Cauldron trades expect BCH-only funding inputs'
      );
    }
  } else {
    if (totalWalletTokenSupply < totalSupply) {
      throw new Error('Token-to-BCH Cauldron trades are missing token funding');
    }
  }

  const buildOutputsForFee = (
    feeSatoshis: bigint
  ): CauldronSettlementOutput[] =>
    buildSettlementOutputs({
      supplyTokenId,
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
      merchantPaymentTerms: params.merchantPaymentTerms,
    });

  let settlementOutputs = buildOutputsForFee(0n);
  let estimatedFeeSatoshis =
    BigInt(
      estimateCauldronTradeTxSize(
        normalizedPoolTrades,
        walletInputs,
        settlementOutputs
      )
    ) * feeRateSatsPerByte;

  for (let i = 0; i < 3; i += 1) {
    settlementOutputs = buildOutputsForFee(estimatedFeeSatoshis);
    const nextFee =
      BigInt(
        estimateCauldronTradeTxSize(
          normalizedPoolTrades,
          walletInputs,
          settlementOutputs
        )
      ) * feeRateSatsPerByte;
    if (nextFee === estimatedFeeSatoshis) break;
    estimatedFeeSatoshis = nextFee;
  }

  const sourceOutputs: Array<Input & Output & ContractInfo> = [
    ...normalizedPoolTrades.map((trade) => buildPoolSourceOutput(trade)),
    ...walletInputs.map((input) => buildWalletSourceOutput(input)),
  ];

  const transaction: TransactionTemplateFixed<unknown> = {
    version: 2,
    locktime: 0,
    inputs: [
      ...normalizedPoolTrades.map((trade) => ({
        outpointIndex: trade.pool.outputIndex,
        outpointTransactionHash: hexToBin(trade.pool.txHash),
        sequenceNumber: 0,
        unlockingBytecode: buildCauldronPoolV0ExchangeUnlockingBytecode(
          trade.pool.parameters
        ),
      })),
      ...walletInputs.map((input) => buildWalletInput(input)),
    ],
    outputs: [
      ...normalizedPoolTrades.map((trade) => buildPoolOutput(trade)),
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
    changeAddress,
    tokenChangeAddress,
  };
}

export function buildCauldronMerchantPaymentRequest(params: {
  poolTrades: CauldronPoolTrade[];
  walletInputs: ResolvedCauldronFundingInput[];
  merchantAddress: string;
  changeAddress: string;
  tokenChangeAddress?: string;
  feeRateSatsPerByte?: bigint | number;
  broadcast?: boolean;
  userPrompt?: string;
  sequence?: number;
  tokenOutputSatoshis?: bigint;
  minimumDemand?: bigint;
  merchantPaymentTerms?: CauldronMerchantPaymentTerms;
}): BuiltCauldronMerchantPaymentRequest {
  const built = buildCauldronTradeRequest({
    poolTrades: params.poolTrades,
    walletInputs: params.walletInputs,
    recipientAddress: params.merchantAddress,
    changeAddress: params.changeAddress,
    tokenChangeAddress: params.tokenChangeAddress,
    feeRateSatsPerByte: params.feeRateSatsPerByte,
    broadcast: params.broadcast,
    userPrompt: params.userPrompt ?? 'Merchant payment in stablecoins',
    sequence: params.sequence,
    tokenOutputSatoshis: params.tokenOutputSatoshis,
    minimumDemand: params.minimumDemand,
    merchantPaymentTerms: params.merchantPaymentTerms,
  });

  const merchantPaymentTerms: CauldronMerchantPaymentTerms =
    params.merchantPaymentTerms ?? {
      incomingAsset: 'bch',
      incomingAmountAtomic: built.totalSupply,
      directIncomingAmountAtomic: 0n,
      merchantBchAmountSatoshis: 0n,
      merchantTokenAmountAtomic: built.totalDemand,
    };

  return {
    ...built,
    paymentKind: 'merchant',
    merchantPaymentMode: 'cauldron',
    merchantOutputIndexes: [
      0,
      ...(merchantPaymentTerms.merchantBchAmountSatoshis > 0n ||
      (merchantPaymentTerms.incomingAsset === 'token' &&
        merchantPaymentTerms.merchantTokenAmountAtomic > 0n)
        ? [1]
        : []),
    ],
    merchantPaymentTerms,
  };
}

export function buildCauldronMerchantDirectPaymentRequest(params: {
  walletInputs: ResolvedCauldronFundingInput[];
  merchantAddress: string;
  changeAddress: string;
  tokenChangeAddress?: string;
  paymentAsset: 'bch' | 'token';
  tokenCategoryHex?: string;
  amountAtomic: bigint;
  requireAdditionalBchUtxo?: boolean;
  feeRateSatsPerByte?: bigint | number;
  broadcast?: boolean;
  userPrompt?: string;
  sequence?: number;
  tokenOutputSatoshis?: bigint;
}): BuiltCauldronMerchantPaymentRequest {
  const {
    walletInputs,
    merchantAddress,
    changeAddress,
    tokenChangeAddress,
    paymentAsset,
    tokenCategoryHex,
    amountAtomic,
    requireAdditionalBchUtxo = true,
    userPrompt,
    tokenOutputSatoshis = BigInt(TOKEN_OUTPUT_SATS),
  } = params;
  if (amountAtomic <= 0n) {
    throw new Error(
      'Direct merchant payment amount must be greater than zero.'
    );
  }
  if (paymentAsset === 'token' && !tokenCategoryHex) {
    throw new Error('Direct token merchant payment is missing its category.');
  }

  const { totalWalletBch, totalMatchingTokenSupply: totalWalletTokenSupply } =
    validateWalletTokenInputs(
      walletInputs,
      paymentAsset === 'token' ? tokenCategoryHex : undefined
    );
  if (
    paymentAsset === 'bch' &&
    walletInputs.some((input) => input.utxo.token)
  ) {
    throw new Error(
      'Direct BCH merchant payments expect BCH-only funding inputs.'
    );
  }
  if (
    paymentAsset === 'token' &&
    requireAdditionalBchUtxo &&
    !walletInputs.some((input) => !input.utxo.token)
  ) {
    throw new Error(
      'Direct token merchant payments require an additional BCH funding UTXO.'
    );
  }
  if (paymentAsset === 'token' && totalWalletTokenSupply < amountAtomic) {
    throw new Error(
      'Not enough token funding for the direct merchant payment.'
    );
  }

  const buildOutputs = (feeSatoshis: bigint): CauldronSettlementOutput[] => {
    if (paymentAsset === 'bch') {
      const change = totalWalletBch - amountAtomic - feeSatoshis;
      if (change < 0n) {
        throw new Error(
          'Insufficient BCH funding for the direct merchant payment.'
        );
      }
      return [
        buildCashAddressOutput(merchantAddress, amountAtomic),
        ...(change >= BigInt(DUST)
          ? [buildCashAddressOutput(changeAddress, change)]
          : []),
      ];
    }

    const tokenChange = totalWalletTokenSupply - amountAtomic;
    const outputs: CauldronSettlementOutput[] = [
      buildCashAddressOutput(merchantAddress, tokenOutputSatoshis, {
        amount: amountAtomic,
        categoryHex: tokenCategoryHex!,
      }),
    ];
    let bchChange = totalWalletBch - feeSatoshis;
    if (tokenChange > 0n) {
      outputs.push(
        buildCashAddressOutput(
          tokenChangeAddress ?? changeAddress,
          tokenOutputSatoshis,
          {
            amount: tokenChange,
            categoryHex: tokenCategoryHex!,
          }
        )
      );
      bchChange -= tokenOutputSatoshis;
    }
    bchChange -= tokenOutputSatoshis;
    if (bchChange < 0n) {
      throw new Error(
        'Insufficient BCH funding for the direct token payment fee.'
      );
    }
    if (bchChange >= BigInt(DUST)) {
      outputs.push(buildCashAddressOutput(changeAddress, bchChange));
    }
    return outputs;
  };

  let settlementOutputs = buildOutputs(0n);
  let estimatedFeeSatoshis =
    BigInt(
      estimateFixedTransactionSize({
        inputSizes: walletInputs.map(() => P2PKH_INPUT_SIZE_BYTES),
        outputs: settlementOutputs,
      })
    ) * normalizeCauldronFeeRate(params.feeRateSatsPerByte);
  for (let i = 0; i < 3; i += 1) {
    settlementOutputs = buildOutputs(estimatedFeeSatoshis);
    const nextFee =
      BigInt(
        estimateFixedTransactionSize({
          inputSizes: walletInputs.map(() => P2PKH_INPUT_SIZE_BYTES),
          outputs: settlementOutputs,
        })
      ) * normalizeCauldronFeeRate(params.feeRateSatsPerByte);
    if (nextFee === estimatedFeeSatoshis) break;
    estimatedFeeSatoshis = nextFee;
  }

  const sourceOutputs = walletInputs.map((input) =>
    buildWalletSourceOutput(input)
  );
  const transaction: TransactionTemplateFixed<unknown> = {
    version: 2,
    locktime: 0,
    inputs: walletInputs.map(buildWalletInput),
    outputs: settlementOutputs,
  };
  const signRequest = {
    action: 'sign_transaction_request',
    time: Date.now(),
    sequence: params.sequence ?? 0,
    inputPaths: walletInputs.map((input, index) => [
      index,
      input.pathName,
      input.addressIndex,
    ]),
    transaction: {
      transaction,
      sourceOutputs,
      broadcast: params.broadcast ?? false,
      userPrompt: userPrompt ?? 'Direct merchant payment',
    },
  } as unknown as SignTransactionRequest;
  const merchantPaymentTerms: CauldronMerchantPaymentTerms = {
    incomingAsset: paymentAsset,
    incomingTokenCategory: tokenCategoryHex,
    incomingAmountAtomic: amountAtomic,
    directIncomingAmountAtomic: amountAtomic,
    merchantBchAmountSatoshis: paymentAsset === 'bch' ? amountAtomic : 0n,
    merchantTokenAmountAtomic: paymentAsset === 'token' ? amountAtomic : 0n,
  };
  return {
    signRequest,
    sourceOutputs,
    settlementOutputs,
    estimatedFeeSatoshis,
    supplyTokenId:
      paymentAsset === 'bch' ? CAULDRON_NATIVE_BCH : tokenCategoryHex!,
    demandTokenId:
      paymentAsset === 'bch' ? CAULDRON_NATIVE_BCH : tokenCategoryHex!,
    totalSupply: amountAtomic,
    totalDemand: amountAtomic,
    walletInputs,
    changeAddress,
    tokenChangeAddress,
    paymentKind: 'merchant',
    merchantPaymentMode: 'direct',
    merchantOutputIndexes: [0],
    merchantPaymentTerms,
  };
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function tokenToPsbtToken(token: Output['token']): PsbtTokenSpec | undefined {
  if (!token) return undefined;
  if (token.nft) {
    const capability = String(token.nft.capability);
    return {
      category: token.category,
      capability:
        capability === 'minting' || capability === '2'
          ? 2
          : capability === 'mutable' || capability === '1'
            ? 1
            : 0,
      commitment: token.nft.commitment,
    };
  }
  return { category: token.category, amount: token.amount };
}

function validatePsbtParentOutput(args: {
  inputIndex: number;
  txid: string;
  vout: number;
  parentHex: string;
  sourceOutput: Input & Output & ContractInfo;
}): Uint8Array {
  const parentBytes = hexToBin(args.parentHex);
  const parentTxid = binToHex(hash256(parentBytes).slice().reverse());
  if (parentTxid.toLowerCase() !== args.txid.toLowerCase()) {
    throw new Error(
      `Cauldron merchant PSBT input ${args.inputIndex} carries a parent transaction for ${parentTxid}, not ${args.txid}.`
    );
  }

  const parent = decodeTransaction(parentBytes);
  if (typeof parent === 'string') {
    throw new Error(
      `Unable to decode the parent transaction for merchant PSBT input ${args.inputIndex}: ${parent}`
    );
  }
  const spent = parent.outputs[args.vout];
  if (!spent) {
    throw new Error(
      `Merchant PSBT input ${args.inputIndex} spends missing parent output ${args.vout}.`
    );
  }
  if (
    spent.valueSatoshis !== args.sourceOutput.valueSatoshis ||
    !byteArraysEqual(spent.lockingBytecode, args.sourceOutput.lockingBytecode)
  ) {
    throw new Error(
      `Merchant PSBT input ${args.inputIndex} parent output does not match the selected source output.`
    );
  }

  const sourceToken = args.sourceOutput.token;
  const parentToken = spent.token;
  if (Boolean(sourceToken) !== Boolean(parentToken)) {
    throw new Error(
      `Merchant PSBT input ${args.inputIndex} parent token state does not match the selected source output.`
    );
  }
  if (
    sourceToken &&
    parentToken &&
    (binToHex(sourceToken.category) !== binToHex(parentToken.category) ||
      sourceToken.amount !== parentToken.amount)
  ) {
    throw new Error(
      `Merchant PSBT input ${args.inputIndex} parent token state does not match the selected source output.`
    );
  }
  return parentBytes;
}

function pathForCauldronInput(input: ResolvedCauldronFundingInput): number[] {
  const branch =
    input.pathName === 'receive' ? 0 : input.pathName === 'change' ? 1 : 7;
  const accountIndex = input.accountIndex ?? 0;
  const coinType = input.coinType ?? 145;
  if (
    !Number.isSafeInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex > 0x7fffffff ||
    !Number.isSafeInteger(coinType) ||
    coinType < 0 ||
    coinType > 0x7fffffff ||
    !Number.isSafeInteger(input.addressIndex) ||
    input.addressIndex < 0 ||
    input.addressIndex > 0x7fffffff
  ) {
    throw new Error('Merchant PSBT input has an invalid BIP32 path.');
  }
  return [
    0x80000000 | 44,
    0x80000000 | coinType,
    0x80000000 | accountIndex,
    branch,
    input.addressIndex,
  ];
}

/**
 * Materialize the complete one-transaction merchant payment as a BCH PSBT.
 *
 * LP inputs are already finalized contract inputs. The buyer wallet inputs
 * carry BIP32 metadata and remain unsigned. The merchant output and LP
 * successor outputs come from the built transaction; buyer BCH change is
 * therefore represented in the same PSBT rather than settled separately.
 */
export async function buildCauldronMerchantPaymentPsbt(
  built: BuiltCauldronMerchantPaymentRequest,
  parentTransactions?: ReadonlyMap<string, string>
): Promise<Uint8Array> {
  if (built.paymentKind !== 'merchant') {
    throw new Error('Merchant PSBT metadata is missing.');
  }

  const transaction = built.signRequest.transaction
    .transaction as unknown as TransactionTemplateFixed<unknown>;
  if (
    transaction.inputs.length !== built.sourceOutputs.length ||
    transaction.inputs.length === 0
  ) {
    throw new Error(
      'Merchant PSBT transaction inputs and source outputs differ.'
    );
  }

  const txids = transaction.inputs.map((input) =>
    binToHex(input.outpointTransactionHash)
  );
  const fetchedParents = parentTransactions
    ? new Map(parentTransactions)
    : await fetchParentTransactions(txids);
  const parentsByTxid = new Map(
    [...fetchedParents.entries()].map(([txid, hex]) => [
      txid.toLowerCase(),
      hex,
    ])
  );
  const poolInputCount = built.sourceOutputs.length - built.walletInputs.length;

  const psbtInputs: PsbtInputSpec[] = transaction.inputs.map(
    (input, inputIndex) => {
      const sourceOutput = built.sourceOutputs[inputIndex];
      if (!sourceOutput) {
        throw new Error(
          `Merchant PSBT input ${inputIndex} has no source output.`
        );
      }
      const txid = txids[inputIndex];
      if (
        binToHex(sourceOutput.outpointTransactionHash).toLowerCase() !==
          txid.toLowerCase() ||
        sourceOutput.outpointIndex !== input.outpointIndex
      ) {
        throw new Error(
          `Merchant PSBT input ${inputIndex} does not match its source outpoint.`
        );
      }
      const parentHex = parentsByTxid.get(txid.toLowerCase());
      if (!parentHex) {
        throw new Error(
          `Merchant PSBT input ${inputIndex} is missing its parent transaction.`
        );
      }
      const parentBytes = validatePsbtParentOutput({
        inputIndex,
        txid,
        vout: input.outpointIndex,
        parentHex,
        sourceOutput,
      });
      const unlockingBytecode = ensureUint8Array(input.unlockingBytecode);
      const lockingBytecode = ensureUint8Array(sourceOutput.lockingBytecode);

      if (sourceOutput.contract) {
        if (unlockingBytecode.length === 0) {
          throw new Error(
            `Merchant PSBT contract input ${inputIndex} is not finalized.`
          );
        }
        return {
          txid,
          vout: input.outpointIndex,
          satoshis: sourceOutput.valueSatoshis,
          lockingBytecode,
          previousTransaction: parentBytes,
          sequence: input.sequenceNumber,
          finalScriptSig: unlockingBytecode,
        };
      }

      const walletInput = built.walletInputs[inputIndex - poolInputCount];
      if (!walletInput?.publicKey || walletInput.publicKey.length !== 33) {
        throw new Error(
          `Merchant PSBT wallet input ${inputIndex} is missing its compressed public key.`
        );
      }
      return {
        txid,
        vout: input.outpointIndex,
        satoshis: sourceOutput.valueSatoshis,
        lockingBytecode,
        previousTransaction: parentBytes,
        publicKey: walletInput.publicKey,
        masterFingerprint: new Uint8Array(4),
        derivationPath: pathForCauldronInput(walletInput),
        sequence: input.sequenceNumber,
      };
    }
  );

  const changeLockingResult = cashAddressToLockingBytecode(built.changeAddress);
  const changeBytecode =
    typeof changeLockingResult === 'string'
      ? null
      : changeLockingResult.bytecode;
  const changeKey = built.walletInputs.find((input) =>
    [input.utxo.address, input.utxo.tokenAddress].includes(built.changeAddress)
  );

  const psbtOutputs: PsbtOutputSpec[] = transaction.outputs.map(
    (output, outputIndex) => {
      const psbtOutput: PsbtOutputSpec = {
        lockingBytecode: ensureUint8Array(output.lockingBytecode),
        satoshis: output.valueSatoshis,
        token: tokenToPsbtToken(output.token),
      };
      if (
        outputIndex >= poolInputCount &&
        changeBytecode &&
        byteArraysEqual(
          ensureUint8Array(output.lockingBytecode),
          changeBytecode
        ) &&
        changeKey?.publicKey
      ) {
        psbtOutput.publicKey = changeKey.publicKey;
        psbtOutput.masterFingerprint = new Uint8Array(4);
        psbtOutput.derivationPath = pathForCauldronInput(changeKey);
      }
      return psbtOutput;
    }
  );

  const routeOutput =
    psbtOutputs[poolInputCount + built.merchantOutputIndexes[0]!];
  const routeIsToken = built.demandTokenId !== CAULDRON_NATIVE_BCH;
  if (
    !routeOutput ||
    (routeIsToken
      ? !routeOutput.token ||
        binToHex(routeOutput.token.category) !== built.demandTokenId ||
        routeOutput.token.amount !== built.totalDemand ||
        routeOutput.satoshis !== BigInt(TOKEN_OUTPUT_SATS)
      : routeOutput.token || routeOutput.satoshis !== built.totalDemand)
  ) {
    throw new Error('Merchant PSBT routed output does not match the proposal.');
  }

  const directOutputIndex = built.merchantOutputIndexes[1];
  if (directOutputIndex !== undefined) {
    const directOutput = psbtOutputs[poolInputCount + directOutputIndex];
    const terms = built.merchantPaymentTerms;
    const expectedDirectToken =
      terms.incomingAsset === 'token' ? terms.merchantTokenAmountAtomic : 0n;
    const expectedDirectBch =
      terms.incomingAsset === 'bch' ? terms.merchantBchAmountSatoshis : 0n;
    if (!directOutput) {
      throw new Error('Merchant PSBT is missing its direct payment output.');
    }
    if (expectedDirectToken > 0n) {
      if (
        !directOutput.token ||
        binToHex(directOutput.token.category) !== terms.incomingTokenCategory ||
        directOutput.token.amount !== expectedDirectToken ||
        directOutput.satoshis !== BigInt(TOKEN_OUTPUT_SATS)
      ) {
        throw new Error(
          'Merchant PSBT direct token output does not match the proposal.'
        );
      }
    } else if (
      directOutput.token ||
      directOutput.satoshis !== expectedDirectBch
    ) {
      throw new Error(
        'Merchant PSBT direct BCH output does not match the proposal.'
      );
    }
  }

  return encodeUnsignedPsbt(
    psbtInputs,
    psbtOutputs,
    SIGHASH_ALL_FORKID_ANYONECANPAY
  );
}

export function buildCauldronPoolDepositRequest(params: {
  walletInputs: ResolvedCauldronFundingInput[];
  withdrawPublicKeyHash: Uint8Array;
  tokenCategoryHex: string;
  tokenAmount: bigint;
  bchAmountSatoshis: bigint;
  ownerAddress: string;
  changeAddress: string;
  feeRateSatsPerByte?: bigint | number;
  broadcast?: boolean;
  userPrompt?: string;
  sequence?: number;
}): BuiltCauldronPoolDepositRequest {
  const {
    walletInputs,
    withdrawPublicKeyHash,
    tokenCategoryHex,
    tokenAmount,
    bchAmountSatoshis,
    ownerAddress,
    changeAddress,
    userPrompt,
  } = params;
  const feeRateSatsPerByte = normalizeCauldronFeeRate(
    params.feeRateSatsPerByte
  );
  const normalizedWithdrawPublicKeyHash = normalizeWithdrawPublicKeyHash(
    withdrawPublicKeyHash,
    ownerAddress
  );
  if (tokenAmount <= 0n) {
    throw new Error('Cauldron pool token amount must be greater than zero');
  }
  if (bchAmountSatoshis < BigInt(DUST)) {
    throw new Error('Cauldron pool BCH amount must be at least dust');
  }

  const { totalWalletBch, totalMatchingTokenSupply } =
    validateWalletTokenInputs(walletInputs, tokenCategoryHex);
  if (totalMatchingTokenSupply < tokenAmount) {
    throw new Error('Token funding is insufficient for Cauldron pool creation');
  }

  const poolOutput: CauldronSettlementOutput = {
    lockingBytecode: buildCauldronPoolV0LockingBytecode({
      withdrawPublicKeyHash: normalizedWithdrawPublicKeyHash,
    }),
    valueSatoshis: bchAmountSatoshis,
    token: {
      amount: tokenAmount,
      category: hexToBin(tokenCategoryHex),
    },
  };

  const buildOutputsForFee = (
    feeSatoshis: bigint
  ): CauldronSettlementOutput[] => {
    const outputs: CauldronSettlementOutput[] = [poolOutput];
    const tokenChangeAmount = totalMatchingTokenSupply - tokenAmount;
    if (tokenChangeAmount < 0n) {
      throw new Error(
        'Token funding is insufficient for Cauldron pool creation'
      );
    }
    if (tokenChangeAmount > 0n) {
      outputs.push(
        buildCashAddressOutput(ownerAddress, BigInt(TOKEN_OUTPUT_SATS), {
          amount: tokenChangeAmount,
          categoryHex: tokenCategoryHex,
        })
      );
    }

    const bchChange =
      totalWalletBch -
      bchAmountSatoshis -
      feeSatoshis -
      (tokenChangeAmount > 0n ? BigInt(TOKEN_OUTPUT_SATS) : 0n);
    if (bchChange >= BigInt(DUST)) {
      outputs.push(buildCashAddressOutput(changeAddress, bchChange));
    } else if (bchChange < 0n) {
      throw new Error('Insufficient BCH funding for Cauldron pool creation');
    }

    return outputs;
  };

  let settlementOutputs = buildOutputsForFee(0n);
  let estimatedFeeSatoshis =
    BigInt(
      estimateFixedTransactionSize({
        inputSizes: walletInputs.map(() => P2PKH_INPUT_SIZE_BYTES),
        outputs: settlementOutputs,
      })
    ) * feeRateSatsPerByte;

  for (let i = 0; i < 3; i += 1) {
    settlementOutputs = buildOutputsForFee(estimatedFeeSatoshis);
    const nextFee =
      BigInt(
        estimateFixedTransactionSize({
          inputSizes: walletInputs.map(() => P2PKH_INPUT_SIZE_BYTES),
          outputs: settlementOutputs,
        })
      ) * feeRateSatsPerByte;
    if (nextFee === estimatedFeeSatoshis) break;
    estimatedFeeSatoshis = nextFee;
  }

  const sourceOutputs = walletInputs.map((input) =>
    buildWalletSourceOutput(input)
  );
  const transaction: TransactionTemplateFixed<unknown> = {
    version: 2,
    locktime: 0,
    inputs: walletInputs.map((input) => buildWalletInput(input)),
    outputs: settlementOutputs,
  };

  const signRequest = {
    action: 'sign_transaction_request',
    time: Date.now(),
    sequence: params.sequence ?? 0,
    inputPaths: walletInputs.map((input, index) => [
      index,
      input.pathName,
      input.addressIndex,
    ]),
    transaction: {
      transaction,
      sourceOutputs,
      broadcast: params.broadcast ?? false,
      userPrompt: userPrompt ?? 'Create Cauldron pool',
    },
  } as unknown as SignTransactionRequest;

  return {
    signRequest,
    sourceOutputs,
    poolOutput,
    settlementOutputs,
    estimatedFeeSatoshis,
    walletInputs,
    withdrawPublicKeyHash: normalizedWithdrawPublicKeyHash,
  };
}

export function buildCauldronPoolWithdrawRequest(params: {
  pool: CauldronPool;
  ownerInput: ResolvedCauldronFundingInput;
  recipientAddress: string;
  feeRateSatsPerByte?: bigint | number;
  broadcast?: boolean;
  userPrompt?: string;
  sequence?: number;
  tokenOutputSatoshis?: bigint;
}): BuiltCauldronPoolWithdrawRequest {
  const { pool, ownerInput, recipientAddress, userPrompt } = params;
  const feeRateSatsPerByte = normalizeCauldronFeeRate(
    params.feeRateSatsPerByte
  );
  const tokenOutputSatoshis =
    params.tokenOutputSatoshis ?? BigInt(TOKEN_OUTPUT_SATS);
  const normalizedWithdrawPublicKeyHash = normalizeWithdrawPublicKeyHash(
    pool.parameters.withdrawPublicKeyHash,
    pool.ownerAddress,
    pool.ownerPublicKeyHash
  );
  const normalizedPool: CauldronPool = {
    ...pool,
    parameters: {
      ...pool.parameters,
      withdrawPublicKeyHash: normalizedWithdrawPublicKeyHash,
    },
  };
  const poolWithdrawInputSize =
    32 +
    4 +
    1 +
    buildCauldronPoolV0WithdrawUnlockingBytecodePlaceholder(
      normalizedPool.parameters
    ).length +
    4;
  const ownerP2pkhInputSize = P2PKH_INPUT_SIZE_BYTES;

  const ownerToken = ownerInput.utxo.token;
  if (ownerToken) {
    throw new Error('Cauldron pool withdrawal owner input must be BCH-only');
  }

  const baseRecipientValue =
    pool.output.amountSatoshis >= tokenOutputSatoshis
      ? pool.output.amountSatoshis
      : tokenOutputSatoshis;
  const ownerBchValue = parseSatoshis(
    ownerInput.utxo.amount ?? ownerInput.utxo.value
  );

  const buildOutputsForFee = (
    feeSatoshis: bigint
  ): CauldronSettlementOutput[] => {
    const requiredFromOwner =
      tokenOutputSatoshis > pool.output.amountSatoshis
        ? tokenOutputSatoshis - pool.output.amountSatoshis
        : 0n;
    const recipientValue = baseRecipientValue - feeSatoshis;
    if (recipientValue < tokenOutputSatoshis) {
      throw new Error(
        'Cauldron pool reserve is too small to withdraw after fee'
      );
    }

    const outputs: CauldronSettlementOutput[] = [
      buildCashAddressOutput(recipientAddress, recipientValue, {
        amount: normalizedPool.output.tokenAmount,
        categoryHex: normalizedPool.output.tokenCategory,
      }),
    ];

    const bchChange = ownerBchValue - requiredFromOwner;
    if (bchChange >= BigInt(DUST)) {
      outputs.push(buildCashAddressOutput(ownerInput.utxo.address, bchChange));
    } else if (bchChange < 0n) {
      throw new Error(
        'Owner BCH input is insufficient to back the withdrawal output'
      );
    }

    return outputs;
  };

  let settlementOutputs = buildOutputsForFee(0n);
  let estimatedFeeSatoshis =
    BigInt(
      estimateFixedTransactionSize({
        inputSizes: [poolWithdrawInputSize, ownerP2pkhInputSize],
        outputs: settlementOutputs,
      })
    ) * feeRateSatsPerByte;

  for (let i = 0; i < 3; i += 1) {
    settlementOutputs = buildOutputsForFee(estimatedFeeSatoshis);
    const nextFee =
      BigInt(
        estimateFixedTransactionSize({
          inputSizes: [poolWithdrawInputSize, ownerP2pkhInputSize],
          outputs: settlementOutputs,
        })
      ) * feeRateSatsPerByte;
    if (nextFee === estimatedFeeSatoshis) break;
    estimatedFeeSatoshis = nextFee;
  }

  const sourceOutputs: Array<Input & Output & ContractInfo> = [
    {
      outpointIndex: pool.outputIndex,
      outpointTransactionHash: hexToBin(pool.txHash),
      sequenceNumber: 0,
      unlockingBytecode:
        buildCauldronPoolV0WithdrawUnlockingBytecodePlaceholder(
          pool.parameters
        ),
      lockingBytecode: pool.output.lockingBytecode,
      valueSatoshis: pool.output.amountSatoshis,
      token: {
        amount: normalizedPool.output.tokenAmount,
        category: hexToBin(normalizedPool.output.tokenCategory),
      },
      ...buildCauldronPoolContractInfo(normalizedWithdrawPublicKeyHash),
    },
    buildWalletSourceOutput(ownerInput),
  ];

  const transaction: TransactionTemplateFixed<unknown> = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointIndex: pool.outputIndex,
        outpointTransactionHash: hexToBin(pool.txHash),
        sequenceNumber: 0,
        unlockingBytecode:
          buildCauldronPoolV0WithdrawUnlockingBytecodePlaceholder(
            normalizedPool.parameters
          ),
      },
      buildWalletInput(ownerInput),
    ],
    outputs: settlementOutputs,
  };

  const signRequest = {
    action: 'sign_transaction_request',
    time: Date.now(),
    sequence: params.sequence ?? 0,
    inputPaths: [
      [0, ownerInput.pathName, ownerInput.addressIndex],
      [1, ownerInput.pathName, ownerInput.addressIndex],
    ],
    transaction: {
      transaction,
      sourceOutputs,
      broadcast: params.broadcast ?? false,
      userPrompt: userPrompt ?? 'Withdraw Cauldron pool',
    },
  } as unknown as SignTransactionRequest;

  return {
    signRequest,
    sourceOutputs,
    settlementOutputs,
    estimatedFeeSatoshis,
    ownerInput,
    pool,
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
  assertSignedTransactionFeeSufficiency({
    signedTransactionHex: signedTransaction,
    sourceOutputs: built.sourceOutputs,
    estimatedFeeSatoshis: built.estimatedFeeSatoshis,
    transactionLabel: 'Cauldron swap',
  });
  assertSignedTransactionCovenantValidity({
    signedTransactionHex: signedTransaction,
    sourceOutputs: built.sourceOutputs,
    transactionLabel: 'Cauldron swap',
  });
  return TransactionService.sendTransaction(
    signedTransaction,
    built.walletInputs.map((input) => input.utxo),
    {
      source: 'cauldron',
      sourceLabel: options?.sourceLabel ?? 'Cauldron',
      recipientSummary: options?.recipientSummary ?? null,
      amountSummary: options?.amountSummary ?? null,
      userPrompt:
        options?.userPrompt ?? built.signRequest.transaction.userPrompt ?? null,
    }
  );
}

export async function signAndBroadcastCauldronMerchantPaymentRequest(
  walletId: number,
  built: BuiltCauldronMerchantPaymentRequest,
  options?: {
    sourceLabel?: string | null;
    recipientSummary?: string | null;
    amountSummary?: string | null;
    userPrompt?: string | null;
  }
) {
  // Materialize and validate the complete transaction-backed PSBT before any
  // wallet signing. The native OPTN adapter still consumes its structured
  // transaction request; the PSBT now proves the same fixed outputs and
  // parent UTXO state instead of relying on the removed second settlement tx.
  await buildCauldronMerchantPaymentPsbt(built);
  return signAndBroadcastCauldronTradeRequest(walletId, built, {
    sourceLabel: options?.sourceLabel ?? 'Cauldron Merchant Pay',
    recipientSummary: options?.recipientSummary ?? null,
    amountSummary: options?.amountSummary ?? null,
    userPrompt:
      options?.userPrompt ?? built.signRequest.transaction.userPrompt ?? null,
  });
}

export async function signAndBroadcastCauldronPoolDepositRequest(
  walletId: number,
  built: BuiltCauldronPoolDepositRequest,
  options?: {
    sourceLabel?: string | null;
    recipientSummary?: string | null;
    amountSummary?: string | null;
    userPrompt?: string | null;
  }
) {
  const adapter = await OptnWizardWalletAdapter.create(walletId);
  const result = await adapter.signTransaction(built.signRequest);
  assertSignedTransactionFeeSufficiency({
    signedTransactionHex: result.signedTransaction,
    sourceOutputs: built.sourceOutputs,
    estimatedFeeSatoshis: built.estimatedFeeSatoshis,
    transactionLabel: 'Cauldron pool creation',
  });
  return TransactionService.sendTransaction(
    result.signedTransaction,
    built.walletInputs.map((input) => input.utxo),
    {
      source: 'cauldron',
      sourceLabel: options?.sourceLabel ?? 'Cauldron Pool',
      recipientSummary: options?.recipientSummary ?? null,
      amountSummary: options?.amountSummary ?? null,
      userPrompt:
        options?.userPrompt ?? built.signRequest.transaction.userPrompt ?? null,
    }
  );
}

export async function signAndBroadcastCauldronPoolWithdrawRequest(
  walletId: number,
  built: BuiltCauldronPoolWithdrawRequest,
  options?: {
    sourceLabel?: string | null;
    recipientSummary?: string | null;
    amountSummary?: string | null;
    userPrompt?: string | null;
  }
) {
  const adapter = await OptnWizardWalletAdapter.create(walletId);
  const result = await adapter.signTransaction(built.signRequest);
  assertSignedTransactionFeeSufficiency({
    signedTransactionHex: result.signedTransaction,
    sourceOutputs: built.sourceOutputs,
    estimatedFeeSatoshis: built.estimatedFeeSatoshis,
    transactionLabel: 'Cauldron pool withdrawal',
  });
  assertSignedTransactionCovenantValidity({
    signedTransactionHex: result.signedTransaction,
    sourceOutputs: built.sourceOutputs,
    transactionLabel: 'Cauldron pool withdrawal',
  });
  return TransactionService.sendTransaction(
    result.signedTransaction,
    [built.ownerInput.utxo],
    {
      source: 'cauldron',
      sourceLabel: options?.sourceLabel ?? 'Cauldron Pool Withdraw',
      recipientSummary: options?.recipientSummary ?? null,
      amountSummary: options?.amountSummary ?? null,
      userPrompt:
        options?.userPrompt ?? built.signRequest.transaction.userPrompt ?? null,
    }
  );
}
