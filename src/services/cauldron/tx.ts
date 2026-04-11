import {
  binToHex,
  bigIntToCompactUint,
  cashAddressToLockingBytecode,
  compactUintPrefixToLength,
  createVirtualMachineBCH,
  decodeTransaction,
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

// Keep Cauldron fee estimates conservative. Wallet P2PKH signatures can
// serialize larger than the 65-byte Schnorr placeholders used in tests.
const P2PKH_INPUT_SIZE_BYTES = 32 + 4 + 1 + (1 + 73 + 1 + 33) + 4;

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
    throw new Error('Signed Cauldron transaction output value exceeds its inputs.');
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
    feeRateSatsPerByte = 1n,
    transactionLabel = 'Cauldron transaction',
  } = args;
  const { actualFeeSatoshis, transactionSizeBytes } =
    calculateSignedTransactionFeeSatoshis(signedTransactionHex, sourceOutputs);
  const minimumRelayFeeSatoshis = transactionSizeBytes * feeRateSatsPerByte;
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

function buildCauldronPoolContractInfo(withdrawPublicKeyHash: Uint8Array): ContractInfo {
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

  const walletInputBytes = walletInputs.length * P2PKH_INPUT_SIZE_BYTES;
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
    ...buildCauldronPoolContractInfo(trade.pool.parameters.withdrawPublicKeyHash),
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
    compactUintPrefixToLength(bigIntToCompactUint(BigInt(inputSizes.length))[0] as number) +
    compactUintPrefixToLength(bigIntToCompactUint(BigInt(outputs.length))[0] as number) +
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
      throw new Error('NFT-bearing UTXOs are not supported for Cauldron funding');
    }
    if (!allowedTokenCategoryHex || token.category !== allowedTokenCategoryHex) {
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

  const {
    totalWalletBch,
    totalMatchingTokenSupply: totalWalletTokenSupply,
  } = validateWalletTokenInputs(
    walletInputs,
    supplyTokenId === CAULDRON_NATIVE_BCH ? undefined : supplyTokenId
  );

  if (supplyTokenId === CAULDRON_NATIVE_BCH) {
    if (walletInputs.some((input) => input.utxo.token)) {
      throw new Error('BCH-to-token Cauldron trades expect BCH-only funding inputs');
    }
  } else {
    if (totalWalletTokenSupply < totalSupply) {
      throw new Error('Token-to-BCH Cauldron trades are missing token funding');
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
    ...walletInputs.map((input) => buildWalletSourceOutput(input)),
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
      ...walletInputs.map((input) => buildWalletInput(input)),
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
  const feeRateSatsPerByte =
    typeof params.feeRateSatsPerByte === 'bigint'
      ? params.feeRateSatsPerByte
      : BigInt(params.feeRateSatsPerByte ?? 1);
  if (tokenAmount <= 0n) {
    throw new Error('Cauldron pool token amount must be greater than zero');
  }
  if (bchAmountSatoshis < BigInt(DUST)) {
    throw new Error('Cauldron pool BCH amount must be at least dust');
  }

  const {
    totalWalletBch,
    totalMatchingTokenSupply,
  } = validateWalletTokenInputs(walletInputs, tokenCategoryHex);
  if (totalMatchingTokenSupply < tokenAmount) {
    throw new Error('Token funding is insufficient for Cauldron pool creation');
  }

  const poolOutput: CauldronSettlementOutput = {
    lockingBytecode: buildCauldronPoolV0LockingBytecode({ withdrawPublicKeyHash }),
    valueSatoshis: bchAmountSatoshis,
    token: {
      amount: tokenAmount,
      category: hexToBin(tokenCategoryHex),
    },
  };

  const buildOutputsForFee = (feeSatoshis: bigint): CauldronSettlementOutput[] => {
    const outputs: CauldronSettlementOutput[] = [poolOutput];
    const tokenChangeAmount = totalMatchingTokenSupply - tokenAmount;
    if (tokenChangeAmount < 0n) {
      throw new Error('Token funding is insufficient for Cauldron pool creation');
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

  const sourceOutputs = walletInputs.map((input) => buildWalletSourceOutput(input));
  const transaction: TransactionTemplateFixed<any> = {
    version: 2,
    locktime: 0,
    inputs: walletInputs.map((input) => buildWalletInput(input)),
    outputs: settlementOutputs,
  };

  const signRequest = {
    action: 'sign_transaction_request',
    time: Date.now(),
    sequence: params.sequence ?? 0,
    inputPaths: walletInputs.map((input, index) => [index, input.pathName, input.addressIndex]),
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
    withdrawPublicKeyHash,
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
  const {
    pool,
    ownerInput,
    recipientAddress,
    userPrompt,
  } = params;
  const feeRateSatsPerByte =
    typeof params.feeRateSatsPerByte === 'bigint'
      ? params.feeRateSatsPerByte
      : BigInt(params.feeRateSatsPerByte ?? 1);
  const tokenOutputSatoshis = params.tokenOutputSatoshis ?? BigInt(TOKEN_OUTPUT_SATS);
  const poolWithdrawInputSize =
    32 +
    4 +
    1 +
    buildCauldronPoolV0WithdrawUnlockingBytecodePlaceholder(pool.parameters).length +
    4;
  const ownerP2pkhInputSize = P2PKH_INPUT_SIZE_BYTES;

  const ownerToken = ownerInput.utxo.token;
  if (ownerToken) {
    throw new Error('Cauldron pool withdrawal owner input must be BCH-only');
  }

  const baseRecipientValue = pool.output.amountSatoshis >= tokenOutputSatoshis
    ? pool.output.amountSatoshis
    : tokenOutputSatoshis;
  const ownerBchValue = parseSatoshis(ownerInput.utxo.amount ?? ownerInput.utxo.value);

  const buildOutputsForFee = (feeSatoshis: bigint): CauldronSettlementOutput[] => {
    const requiredFromOwner = tokenOutputSatoshis > pool.output.amountSatoshis
      ? tokenOutputSatoshis - pool.output.amountSatoshis
      : 0n;
    const recipientValue = baseRecipientValue - feeSatoshis;
    if (recipientValue < tokenOutputSatoshis) {
      throw new Error('Cauldron pool reserve is too small to withdraw after fee');
    }

    const outputs: CauldronSettlementOutput[] = [
      buildCashAddressOutput(recipientAddress, recipientValue, {
        amount: pool.output.tokenAmount,
        categoryHex: pool.output.tokenCategory,
      }),
    ];

    const bchChange = ownerBchValue - requiredFromOwner;
    if (bchChange >= BigInt(DUST)) {
      outputs.push(buildCashAddressOutput(ownerInput.utxo.address, bchChange));
    } else if (bchChange < 0n) {
      throw new Error('Owner BCH input is insufficient to back the withdrawal output');
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
      unlockingBytecode: buildCauldronPoolV0WithdrawUnlockingBytecodePlaceholder(
        pool.parameters
      ),
      lockingBytecode: pool.output.lockingBytecode,
      valueSatoshis: pool.output.amountSatoshis,
      token: {
        amount: pool.output.tokenAmount,
        category: hexToBin(pool.output.tokenCategory),
      },
      ...buildCauldronPoolContractInfo(pool.parameters.withdrawPublicKeyHash),
    },
    buildWalletSourceOutput(ownerInput),
  ];

  const transaction: TransactionTemplateFixed<any> = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointIndex: pool.outputIndex,
        outpointTransactionHash: hexToBin(pool.txHash),
        sequenceNumber: 0,
        unlockingBytecode: buildCauldronPoolV0WithdrawUnlockingBytecodePlaceholder(
          pool.parameters
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
      userPrompt: options?.userPrompt ?? built.signRequest.transaction.userPrompt ?? null,
    }
  );
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
      userPrompt: options?.userPrompt ?? built.signRequest.transaction.userPrompt ?? null,
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
      userPrompt: options?.userPrompt ?? built.signRequest.transaction.userPrompt ?? null,
    }
  );
}
