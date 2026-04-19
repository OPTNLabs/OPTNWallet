import {
  bigIntToVmNumber,
  binToHex,
  cashAddressToLockingBytecode,
  createCompilerBCH,
  createVirtualMachineBch2026,
  decodeAuthenticationInstructions,
  encodeAuthenticationInstructions,
  encodeTransaction,
  flattenBinArray,
  hash256,
  hexToBin,
  importWalletTemplate,
  swapEndianness,
  walletTemplateToCompilerConfiguration,
} from '@bitauth/libauth';
import { compileScriptRaw } from '@bitauth/libauth/build/lib/language/resolve.js';

import quantumrootTemplateJson from '../../../reference/quantumroot/quantumroot-schnorr-lm-ots-vault.json';
import type { UTXO } from '../types/types';
import { TOKEN_OUTPUT_SATS } from '../utils/constants';
import {
  getQuantumrootTemplateWithOverrides,
  signQuantumrootMessage,
  type QuantumrootVaultArtifacts,
} from './QuantumrootService';

type QuantumrootRecoveryVault = QuantumrootVaultArtifacts & {
  quantumLockAddress: string;
  quantumLockLockingBytecode: Uint8Array;
  receiveAddress: string;
  receiveLockingBytecode: Uint8Array;
};

type LibauthTokenData = {
  amount: bigint;
  category: Uint8Array;
  nft?: {
    capability: 'none' | 'mutable' | 'minting';
    commitment: Uint8Array;
  };
};

type RecoveryInput = {
  outpointIndex: number;
  outpointTransactionHash: Uint8Array;
  sequenceNumber: number;
  unlockingBytecode: Uint8Array;
};

type RecoveryOutput = {
  lockingBytecode: Uint8Array;
  token?: LibauthTokenData;
  valueSatoshis: bigint;
};

type RecoveryTransaction = {
  version: number;
  locktime: number;
  inputs: RecoveryInput[];
  outputs: RecoveryOutput[];
};

const importedQuantumrootTemplate = importWalletTemplate(quantumrootTemplateJson);

if (typeof importedQuantumrootTemplate === 'string') {
  throw new Error(importedQuantumrootTemplate);
}

const quantumrootTemplate = importedQuantumrootTemplate;

export type QuantumrootRecoveryBuildRequest = {
  destinationAddress: string;
  feeRateSatsPerByte?: bigint;
  utxo: UTXO;
  vault: QuantumrootRecoveryVault;
  vaultTokenCategory?: string;
};

export type QuantumrootRecoverySweepBuildRequest = {
  destinationAddress: string;
  feeRateSatsPerByte?: bigint;
  utxos: UTXO[];
  vault: QuantumrootRecoveryVault;
  vaultTokenCategory?: string;
};

export type QuantumrootAuthorizedSpendBuildRequest = {
  controlTokenUtxo: UTXO;
  destinationAddress: string;
  feeRateSatsPerByte?: bigint;
  receiveUtxos: UTXO[];
  successorQuantumLockAddress: string;
  successorQuantumLockLockingBytecode: Uint8Array;
  vault: QuantumrootRecoveryVault;
  vaultTokenCategory: string;
};

export type QuantumrootAuthorizedSpendBuildResult = {
  controlTokenCategory: string;
  feeSats: bigint;
  inputCount: number;
  rawTransaction: string;
  recoveryAmountSats: bigint;
  successorQuantumLockAddress: string;
  sweptUtxos: UTXO[];
  transactionByteLength: number;
};

export type QuantumrootRecoverySweepPlanItem = {
  utxo: UTXO;
  transaction: QuantumrootRecoveryBuildResult;
};

export type QuantumrootRecoverySweepPlan = {
  items: QuantumrootRecoverySweepPlanItem[];
  totalFeeSats: bigint;
  totalRecoveryAmountSats: bigint;
};

export type QuantumrootAggregateRecoverySweepBuildResult = {
  feeSats: bigint;
  inputCount: number;
  rawTransaction: string;
  recoveryAmountSats: bigint;
  sweptUtxos: UTXO[];
  transactionByteLength: number;
};

export type QuantumrootRecoveryBuildResult = {
  feeSats: bigint;
  rawTransaction: string;
  recoveryAmountSats: bigint;
  transactionByteLength: number;
};

const DEFAULT_FEE_RATE = 1n;
const DUST_LIMIT = 546n;
const MAX_FEE_ITERATIONS = 6;

function toBigIntSats(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return BigInt(value);
  }
  return 0n;
}

function deriveFeeFromBytes(byteLength: number, feeRateSatsPerByte: bigint) {
  return BigInt(byteLength) * feeRateSatsPerByte;
}

function createQuantumrootCompiler() {
  return createCompilerBCH(walletTemplateToCompilerConfiguration(quantumrootTemplate));
}

function createPatchedQuantumrootCompiler(vault: QuantumrootRecoveryVault) {
  return createCompilerBCH(
    walletTemplateToCompilerConfiguration(
      getQuantumrootTemplateWithOverrides({
        quantumPublicKey: vault.quantumPublicKey,
      })
    )
  );
}

function buildRecoveryCompilationData({
  leafSpendIndex = encodeLeafSpendIndex(0),
  inputIndex,
  inputs,
  outputs,
  quantumSpendIndex = encodeLeafSpendIndex(0),
  sourceOutputs,
  tokenSpendIndex = encodeLeafSpendIndex(0),
  vault,
  vaultTokenCategory,
}: {
  leafSpendIndex?: string;
  inputIndex: number;
  inputs: RecoveryInput[];
  outputs: RecoveryOutput[];
  quantumSpendIndex?: string;
  sourceOutputs: RecoveryOutput[];
  tokenSpendIndex?: string;
  vault: QuantumrootRecoveryVault;
  vaultTokenCategory: string;
}) {
  return {
    hdKeys: {
      addressIndex: vault.addressIndex,
      hdPrivateKeys: { owner: vault.accountHdPrivateKey },
    },
    bytecode: {
      leaf_spend_index: leafSpendIndex,
      online_quantum_signer: '0',
      quantum_spend_index: quantumSpendIndex,
      token_spend_index: tokenSpendIndex,
      vault_token_category: formatVaultTokenCategoryForTemplate(vaultTokenCategory),
    },
    compilationContext: {
      inputIndex,
      sourceOutputs,
      transaction: {
        version: 2,
        locktime: 0,
        inputs,
        outputs,
      },
    },
  } as unknown as Parameters<ReturnType<typeof createQuantumrootCompiler>['generateBytecode']>[0]['data'];
}

function encodeLeafSpendIndex(index: number) {
  return binToHex(bigIntToVmNumber(BigInt(index)));
}

function normalizeTokenCategory(category: string) {
  return category.trim().replace(/^0x/i, '').toLowerCase();
}

function formatVaultTokenCategoryForTemplate(category: string) {
  return `0x${swapEndianness(normalizeTokenCategory(category))}`;
}

function toLibauthToken(token: NonNullable<UTXO['token']>) {
  return {
    amount: toBigIntSats(token.amount),
    category: hexToBin(swapEndianness(normalizeTokenCategory(token.category))),
    ...(token.nft
      ? {
          nft: {
            capability: token.nft.capability,
            commitment: hexToBin(token.nft.commitment),
          },
        }
      : {}),
  };
}

function compileQuantumrootUnlockingBytecode({
  compiler,
  compilationData,
  scriptId,
}: {
  compiler: ReturnType<typeof createQuantumrootCompiler>;
  compilationData: Parameters<ReturnType<typeof createQuantumrootCompiler>['generateBytecode']>[0]['data'];
  scriptId: 'introspection_spend' | 'quantum_unlock' | 'schnorr_spend' | 'token_spend';
}) {
  const result = compiler.generateBytecode({
    data: compilationData,
    scriptId,
  });
  if (!result.success) {
    throw new Error(
      `Quantumroot recovery unlocking-bytecode compilation failed for ${scriptId}: ${JSON.stringify(
        (result as any).errors
      )}`
    );
  }
  return result.bytecode;
}

function compileQuantumrootRawScript({
  compiler,
  compilationData,
  scriptId,
}: {
  compiler: ReturnType<typeof createQuantumrootCompiler>;
  compilationData: Parameters<ReturnType<typeof createQuantumrootCompiler>['generateBytecode']>[0]['data'];
  scriptId:
    | 'quantum_lock'
    | 'quantum_lock_serialize_transaction'
    | 'quantum_lock_verify_transaction_shape'
    | 'receive_address'
    | 'receive_address_schnorr_spend'
    | 'receive_address_token_spend';
}) {
  const result = compileScriptRaw({
    configuration: compiler.configuration,
    data: compilationData,
    scriptId,
  });
  if (!result.success) {
    throw new Error(
      `Quantumroot raw-script compilation failed for ${scriptId}: ${JSON.stringify(
        (result as any).errors
      )}`
    );
  }
  return result.bytecode;
}

function verifyQuantumrootTransaction({
  sourceOutputs,
  transaction,
}: {
  sourceOutputs: RecoveryOutput[];
  transaction: RecoveryTransaction;
}) {
  const vm = createVirtualMachineBch2026();

  for (let inputIndex = 0; inputIndex < transaction.inputs.length; inputIndex += 1) {
    const verificationProgram = {
      inputIndex,
      sourceOutputs,
      transaction,
    } as Parameters<typeof vm.verify>[0];
    const verification = vm.verify(verificationProgram);
    if (verification !== true) {
      const trace = vm.debug(verificationProgram as any);
      const finalState = trace[trace.length - 1];
      const finalStackHex =
        finalState && 'stack' in finalState
          ? (finalState.stack as Uint8Array[]).map((item) => binToHex(item))
          : [];
      const traceTail = trace.slice(-5).map((state) => {
        const stack =
          state && 'stack' in state
            ? (state.stack as Uint8Array[]).map((item) => binToHex(item))
            : [];
        return JSON.stringify(
          {
            ...(state && typeof state === 'object' ? state : {}),
            stack,
          },
          (_key, value) => (typeof value === 'bigint' ? value.toString() : value)
        );
      });
      throw new Error(
        `Quantumroot recovery transaction verification failed at input ${inputIndex}: ${verification}; final stack: [${finalStackHex.join(', ')}]; trace tail: ${traceTail.join(' | ')}`
      );
    }
  }
}

function evaluateQuantumrootLockingScript({
  lockingBytecode,
  transaction,
}: {
  lockingBytecode: Uint8Array;
  transaction: RecoveryTransaction;
}) {
  const vm = createVirtualMachineBch2026();
  const evaluationTransaction = {
    ...transaction,
    inputs: transaction.inputs.map((input) => ({
      ...input,
      unlockingBytecode: Uint8Array.of(),
    })),
  };
  const sourceOutputs = [
    {
      lockingBytecode,
      valueSatoshis: 1n,
    },
  ];
  const trace = vm.debug({
    inputIndex: 0,
    sourceOutputs,
    transaction: evaluationTransaction,
  } as Parameters<typeof vm.debug>[0]);
  const finalState = trace[trace.length - 1];
  if (!finalState || !('stack' in finalState) || finalState.stack.length === 0) {
    throw new Error('Quantumroot script evaluation produced no stack result.');
  }
  return finalState.stack[finalState.stack.length - 1] as Uint8Array;
}

function createCorrectedQuantumLockSignedMessage({
  compilationData,
  transaction,
  vault,
}: {
  compilationData: Parameters<ReturnType<typeof createQuantumrootCompiler>['generateBytecode']>[0]['data'];
  transaction: RecoveryTransaction;
  vault: QuantumrootRecoveryVault;
}) {
  const compiler = createPatchedQuantumrootCompiler(vault);
  const serializeScript = compileQuantumrootRawScript({
    compiler,
    compilationData,
    scriptId: 'quantum_lock_serialize_transaction',
  });
  const serializationHash = evaluateQuantumrootLockingScript({
    lockingBytecode: serializeScript,
    transaction,
  });
  const verifyScript = compileQuantumrootRawScript({
    compiler,
    compilationData,
    scriptId: 'quantum_lock_verify_transaction_shape',
  });
  const correctedCommitment = hash256(serializationHash);
  const verifyInstructions = decodeAuthenticationInstructions(verifyScript).map(
    (instruction) =>
      'data' in instruction &&
      instruction.data !== undefined &&
      instruction.data.length === 32
        ? { ...instruction, data: correctedCommitment }
        : instruction
  );

  return {
    correctedSignedMessage: encodeAuthenticationInstructions(verifyInstructions),
    serializationHash,
  };
}

function buildManualQuantumUnlockingBytecode({
  compilationData,
  transaction,
  vault,
}: {
  compilationData: Parameters<ReturnType<typeof createQuantumrootCompiler>['generateBytecode']>[0]['data'];
  transaction: RecoveryTransaction;
  vault: QuantumrootRecoveryVault;
}) {
  const compiler = createPatchedQuantumrootCompiler(vault);
  const { correctedSignedMessage } = createCorrectedQuantumLockSignedMessage({
      compilationData,
      transaction,
      vault,
    });
  const generatedUnlock = compileQuantumrootUnlockingBytecode({
    compiler,
    compilationData,
    scriptId: 'quantum_unlock',
  });
  const instructions = decodeAuthenticationInstructions(generatedUnlock);
  if (
    instructions.length < 7 ||
    !('data' in instructions[1]) ||
    instructions[1].data === undefined ||
    !('data' in instructions[4]) ||
    instructions[4].data === undefined
  ) {
    throw new Error('Quantumroot compiler produced an unexpected quantum_unlock layout.');
  }
  const randomizer = instructions[4].data;
  const quantumSignature = signQuantumrootMessage(
    correctedSignedMessage,
    vault.quantumPrivateKey,
    vault.quantumKeyIdentifier,
    randomizer
  ).signature;

  return encodeAuthenticationInstructions(
    instructions.map((instruction, index) =>
      index === 1
        ? { ...instruction, data: flattenBinArray(quantumSignature.Y) }
        : index === 5
          ? { ...instruction, data: correctedSignedMessage }
          : instruction
    )
  );
}

function buildManualTokenSpendUnlockingBytecode({
  compilationData,
}: {
  compilationData: Parameters<ReturnType<typeof createQuantumrootCompiler>['generateBytecode']>[0]['data'];
}) {
  const compiler = createQuantumrootCompiler();
  return compileQuantumrootUnlockingBytecode({
    compiler,
    compilationData,
    scriptId: 'token_spend',
  });
}

function compileQuantumrootRecoveryTransaction({
  destinationAddress,
  inputValueSats,
  feeSats,
  outpointIndex,
  outpointTransactionHash,
  vault,
  vaultTokenCategory,
  unlockingScriptId,
}: {
  destinationAddress: string;
  feeSats: bigint;
  inputValueSats: bigint;
  outpointIndex: number;
  outpointTransactionHash: string;
  vault: QuantumrootRecoveryVault;
  vaultTokenCategory: string;
  unlockingScriptId: 'schnorr_spend' | 'quantum_unlock';
}) {
  const recoveryAmountSats = inputValueSats - feeSats;
  if (recoveryAmountSats <= DUST_LIMIT) {
    throw new Error(
      `Quantumroot recovery output would fall below dust after fees: ${recoveryAmountSats.toString()} sats`
    );
  }

  const destinationLockingBytecode = cashAddressToLockingBytecode(destinationAddress);
  if (typeof destinationLockingBytecode === 'string') {
    throw new Error(destinationLockingBytecode);
  }

  const compiler = createQuantumrootCompiler();

  const transactionInputs = [
    {
      outpointIndex,
      outpointTransactionHash: hexToBin(outpointTransactionHash),
      sequenceNumber: 0,
      unlockingBytecode: Uint8Array.of(),
    },
  ];
  const transactionOutputs = [
    {
      lockingBytecode: destinationLockingBytecode.bytecode,
      valueSatoshis: recoveryAmountSats,
    },
  ];
  const sourceOutputs = [
    {
      lockingBytecode:
        unlockingScriptId === 'schnorr_spend'
          ? vault.receiveLockingBytecode
          : vault.quantumLockLockingBytecode,
      valueSatoshis: inputValueSats,
    },
  ];

    const compilationData = buildRecoveryCompilationData({
      inputIndex: 0,
      inputs: transactionInputs,
      outputs: transactionOutputs,
    sourceOutputs,
    vault,
    vaultTokenCategory,
  });
  const transaction = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointIndex,
        outpointTransactionHash: hexToBin(outpointTransactionHash),
        sequenceNumber: 0,
        unlockingBytecode: Uint8Array.of(),
      },
    ],
    outputs: [
      {
        lockingBytecode: destinationLockingBytecode.bytecode,
        valueSatoshis: recoveryAmountSats,
      },
    ],
  };
  const unlockingBytecode =
    unlockingScriptId === 'quantum_unlock'
      ? buildManualQuantumUnlockingBytecode({
          compilationData,
          transaction,
          vault,
        })
      : compileQuantumrootUnlockingBytecode({
          compiler,
          compilationData,
          scriptId: unlockingScriptId,
        });
  transaction.inputs[0].unlockingBytecode = unlockingBytecode;

  verifyQuantumrootTransaction({
    sourceOutputs,
    transaction,
  });

  const transactionBytes = encodeTransaction(transaction);
  return {
    rawTransaction: binToHex(transactionBytes),
    recoveryAmountSats,
    transactionByteLength: transactionBytes.length,
  };
}

function assertAuthorizedSpendInputs({
  controlTokenUtxo,
  receiveUtxos,
  vault,
  vaultTokenCategory,
}: {
  controlTokenUtxo: UTXO;
  receiveUtxos: UTXO[];
  vault: QuantumrootRecoveryVault;
  vaultTokenCategory: string;
}) {
  if (receiveUtxos.length === 0) {
    throw new Error('Quantumroot authorized spend requires at least one receive UTXO.');
  }
  if (controlTokenUtxo.address !== vault.quantumLockAddress) {
    throw new Error('Quantumroot authorized spend requires a control token from the Quantum Lock address.');
  }
  if (!controlTokenUtxo.token) {
    throw new Error('Quantumroot authorized spend requires a control token UTXO.');
  }
  const normalizedExpectedCategory = normalizeTokenCategory(vaultTokenCategory);
  const normalizedControlCategory = normalizeTokenCategory(controlTokenUtxo.token.category);
  if (normalizedExpectedCategory.length !== 64) {
    throw new Error('Quantumroot authorized spend requires a configured 32-byte control token category.');
  }
  if (normalizedControlCategory !== normalizedExpectedCategory) {
    throw new Error('Quantumroot authorized spend requires a matching control token category.');
  }
  for (const utxo of receiveUtxos) {
    if (utxo.address !== vault.receiveAddress) {
      throw new Error('Quantumroot authorized spend currently requires receive UTXOs from the same vault receive address.');
    }
    if (utxo.token) {
      throw new Error('Quantumroot authorized spend currently supports BCH-only receive UTXOs.');
    }
  }
}

export function buildQuantumrootAuthorizedSpendTransaction({
  controlTokenUtxo,
  destinationAddress,
  feeRateSatsPerByte = DEFAULT_FEE_RATE,
  receiveUtxos,
  successorQuantumLockAddress,
  successorQuantumLockLockingBytecode,
  vault,
  vaultTokenCategory,
}: QuantumrootAuthorizedSpendBuildRequest): QuantumrootAuthorizedSpendBuildResult {
  assertAuthorizedSpendInputs({
    controlTokenUtxo,
    receiveUtxos,
    vault,
    vaultTokenCategory,
  });

  const destinationLockingBytecode = cashAddressToLockingBytecode(destinationAddress);
  if (typeof destinationLockingBytecode === 'string') {
    throw new Error(destinationLockingBytecode);
  }

  const controlToken = toLibauthToken(controlTokenUtxo.token!);
  const normalizedTokenCategory = normalizeTokenCategory(vaultTokenCategory);
  const receiveInputValueSats = receiveUtxos.reduce(
    (sum, utxo) => sum + toBigIntSats(utxo.value ?? utxo.amount ?? 0),
    0n
  );
  const controlInputValueSats = toBigIntSats(
    controlTokenUtxo.value ?? controlTokenUtxo.amount ?? 0
  );
  const totalInputValueSats = receiveInputValueSats + controlInputValueSats;
  const tokenDustLimit = BigInt(TOKEN_OUTPUT_SATS);
  const successorTokenOutputValueSats = controlInputValueSats >= tokenDustLimit
    ? controlInputValueSats
    : tokenDustLimit;

  let feeSats =
    (260n + BigInt(receiveUtxos.length) * 42n) * feeRateSatsPerByte;

  for (let iteration = 0; iteration < MAX_FEE_ITERATIONS; iteration += 1) {
    const recoveryAmountSats =
      totalInputValueSats - successorTokenOutputValueSats - feeSats;
    if (recoveryAmountSats <= DUST_LIMIT) {
      throw new Error(
        `Quantumroot authorized spend output would fall below dust after fees: ${recoveryAmountSats.toString()} sats`
      );
    }

    const compiler = createQuantumrootCompiler();
    const sourceOutputs = [
      {
        lockingBytecode: vault.quantumLockLockingBytecode,
        token: controlToken,
        valueSatoshis: controlInputValueSats,
      },
      ...receiveUtxos.map((utxo) => ({
        lockingBytecode: vault.receiveLockingBytecode,
        valueSatoshis: toBigIntSats(utxo.value ?? utxo.amount ?? 0),
      })),
    ];
    const baseInputs = [
      {
        outpointIndex: controlTokenUtxo.tx_pos,
        outpointTransactionHash: hexToBin(controlTokenUtxo.tx_hash),
        sequenceNumber: 0,
        unlockingBytecode: Uint8Array.of(),
      },
      ...receiveUtxos.map((utxo) => ({
        outpointIndex: utxo.tx_pos,
        outpointTransactionHash: hexToBin(utxo.tx_hash),
        sequenceNumber: 0,
        unlockingBytecode: Uint8Array.of(),
      })),
    ];
    const outputs = [
      {
        lockingBytecode: successorQuantumLockLockingBytecode,
        token: controlToken,
        valueSatoshis: successorTokenOutputValueSats,
      },
      {
        lockingBytecode: destinationLockingBytecode.bytecode,
        valueSatoshis: recoveryAmountSats,
      },
    ];

    const quantumCompilationData = buildRecoveryCompilationData({
      inputIndex: 0,
      inputs: baseInputs,
      outputs,
      sourceOutputs,
      vault,
      vaultTokenCategory: normalizedTokenCategory,
    });
    const transactionDraft: RecoveryTransaction = {
      version: 2,
      locktime: 0,
      inputs: baseInputs.map((input) => ({ ...input })),
      outputs,
    };
    const quantumUnlockingBytecode = buildManualQuantumUnlockingBytecode({
      compilationData: quantumCompilationData,
      transaction: transactionDraft,
      vault,
    });

    const tokenCompilationData = buildRecoveryCompilationData({
      inputIndex: 1,
      inputs: baseInputs.map((input, inputIndex) =>
        inputIndex === 0 ? { ...input, unlockingBytecode: quantumUnlockingBytecode } : input
      ),
      outputs,
      sourceOutputs,
      vault,
      vaultTokenCategory: normalizedTokenCategory,
    });
    const tokenUnlockingBytecode = buildManualTokenSpendUnlockingBytecode({
      compilationData: tokenCompilationData,
    });

    const finalInputs = baseInputs.map((input, inputIndex) => {
      if (inputIndex === 0) {
        return { ...input, unlockingBytecode: quantumUnlockingBytecode };
      }
      if (inputIndex === 1) {
        return { ...input, unlockingBytecode: tokenUnlockingBytecode };
      }

      const introspectionCompilationData = buildRecoveryCompilationData({
        leafSpendIndex: encodeLeafSpendIndex(1),
        inputIndex,
        inputs: baseInputs.map((baseInput, nestedInputIndex) =>
          nestedInputIndex === 0
            ? { ...baseInput, unlockingBytecode: quantumUnlockingBytecode }
            : nestedInputIndex === 1
              ? { ...baseInput, unlockingBytecode: tokenUnlockingBytecode }
              : baseInput
        ),
        outputs,
        sourceOutputs,
        vault,
        vaultTokenCategory: normalizedTokenCategory,
      });

      return {
        ...input,
        unlockingBytecode: compileQuantumrootUnlockingBytecode({
          compiler,
          compilationData: introspectionCompilationData,
          scriptId: 'introspection_spend',
        }),
      };
    });

    const transaction = {
      version: 2,
      locktime: 0,
      inputs: finalInputs,
      outputs,
    };

    verifyQuantumrootTransaction({
      sourceOutputs,
      transaction,
    });

    const transactionBytes = encodeTransaction(transaction);
    const nextFee = deriveFeeFromBytes(transactionBytes.length, feeRateSatsPerByte);
    if (nextFee === feeSats) {
      return {
        controlTokenCategory: normalizedTokenCategory,
        feeSats,
        inputCount: finalInputs.length,
        rawTransaction: binToHex(transactionBytes),
        recoveryAmountSats,
        successorQuantumLockAddress,
        sweptUtxos: receiveUtxos,
        transactionByteLength: transactionBytes.length,
      };
    }
    feeSats = nextFee;
  }

  throw new Error('Failed to compile Quantumroot authorized spend transaction.');
}

export function buildQuantumrootAggregateRecoverySweepTransaction({
  destinationAddress,
  feeRateSatsPerByte = DEFAULT_FEE_RATE,
  utxos,
  vault,
  vaultTokenCategory = '00'.repeat(32),
}: QuantumrootRecoverySweepBuildRequest): QuantumrootAggregateRecoverySweepBuildResult {
  assertBchOnlyUtxos(utxos, 'Quantumroot aggregate sweep');

  if (utxos.length === 1) {
    const single = buildQuantumrootRecoveryTransaction({
      destinationAddress,
      feeRateSatsPerByte,
      utxo: utxos[0],
      vault,
      vaultTokenCategory,
    });
    return {
      ...single,
      inputCount: 1,
      sweptUtxos: utxos,
    };
  }

  const destinationLockingBytecode = cashAddressToLockingBytecode(destinationAddress);
  if (typeof destinationLockingBytecode === 'string') {
    throw new Error(destinationLockingBytecode);
  }

  for (const utxo of utxos) {
    if (utxo.address !== vault.receiveAddress) {
      throw new Error(
        'Quantumroot aggregate sweep currently requires all UTXOs to belong to the same receive address.'
      );
    }
  }

  const sourceOutputs = utxos.map((utxo) => ({
    lockingBytecode: vault.receiveLockingBytecode,
    valueSatoshis: toBigIntSats(utxo.value ?? utxo.amount ?? 0),
  }));
  const totalInputValueSats = sourceOutputs.reduce(
    (sum, output) => sum + output.valueSatoshis,
    0n
  );

  if (totalInputValueSats <= DUST_LIMIT) {
    throw new Error('Quantumroot aggregate sweep requires funded BCH UTXOs above dust.');
  }

  let feeSats = (220n + BigInt(utxos.length) * 40n) * feeRateSatsPerByte;

  for (let iteration = 0; iteration < MAX_FEE_ITERATIONS; iteration += 1) {
    const recoveryAmountSats = totalInputValueSats - feeSats;
    if (recoveryAmountSats <= DUST_LIMIT) {
      throw new Error(
        `Quantumroot aggregate sweep output would fall below dust after fees: ${recoveryAmountSats.toString()} sats`
      );
    }

    const compiler = createQuantumrootCompiler();
    const baseInputs = utxos.map((utxo) => ({
      outpointIndex: utxo.tx_pos,
      outpointTransactionHash: hexToBin(utxo.tx_hash),
      sequenceNumber: 0,
      unlockingBytecode: Uint8Array.of(),
    }));
    const outputs = [
      {
        lockingBytecode: destinationLockingBytecode.bytecode,
        valueSatoshis: recoveryAmountSats,
      },
    ];

    const masterCompilationData = buildRecoveryCompilationData({
      leafSpendIndex: encodeLeafSpendIndex(0),
      inputIndex: 0,
      inputs: baseInputs,
      outputs,
      sourceOutputs,
      vault,
      vaultTokenCategory,
    });
    const masterUnlockingBytecode = compileQuantumrootUnlockingBytecode({
      compiler,
      compilationData: masterCompilationData,
      scriptId: 'schnorr_spend',
    });

    const finalInputs = baseInputs.map((input, inputIndex) => {
      if (inputIndex === 0) {
        return {
          ...input,
          unlockingBytecode: masterUnlockingBytecode,
        };
      }

      const introspectionCompilationData = buildRecoveryCompilationData({
        leafSpendIndex: encodeLeafSpendIndex(0),
        inputIndex,
        inputs: baseInputs.map((baseInput, nestedInputIndex) =>
          nestedInputIndex === 0
            ? { ...baseInput, unlockingBytecode: masterUnlockingBytecode }
            : baseInput
        ),
        outputs,
        sourceOutputs,
        vault,
        vaultTokenCategory,
      });

      const introspectionUnlockingBytecode = compileQuantumrootUnlockingBytecode({
        compiler,
        compilationData: introspectionCompilationData,
        scriptId: 'introspection_spend',
      });

      return {
        ...input,
        unlockingBytecode: introspectionUnlockingBytecode,
      };
    });

    const transaction = {
      version: 2,
      locktime: 0,
      inputs: finalInputs,
      outputs,
    };

    verifyQuantumrootTransaction({
      sourceOutputs,
      transaction,
    });

    const transactionBytes = encodeTransaction(transaction);
    const nextFee = deriveFeeFromBytes(transactionBytes.length, feeRateSatsPerByte);
    if (nextFee === feeSats) {
      return {
        feeSats,
        inputCount: utxos.length,
        rawTransaction: binToHex(transactionBytes),
        recoveryAmountSats,
        sweptUtxos: utxos,
        transactionByteLength: transactionBytes.length,
      };
    }
    feeSats = nextFee;
  }

  throw new Error('Failed to compile Quantumroot aggregate sweep transaction.');
}

function assertBchOnlyUtxos(utxos: UTXO[], errorPrefix: string) {
  if (utxos.length === 0) {
    throw new Error(`${errorPrefix} requires at least one BCH UTXO.`);
  }

  for (const utxo of utxos) {
    if (utxo.token) {
      throw new Error(`${errorPrefix} currently supports BCH-only receive UTXOs.`);
    }
  }
}

export function buildQuantumrootRecoverySweepPlan({
  destinationAddress,
  feeRateSatsPerByte,
  utxos,
  vault,
  vaultTokenCategory = '00'.repeat(32),
}: QuantumrootRecoverySweepBuildRequest): QuantumrootRecoverySweepPlan {
  assertBchOnlyUtxos(utxos, 'Quantumroot sweep');

  const items = utxos.map((utxo) => ({
    utxo,
    transaction: buildQuantumrootRecoveryTransaction({
      destinationAddress,
      feeRateSatsPerByte,
      utxo,
      vault,
      vaultTokenCategory,
    }),
  }));

  return {
    items,
    totalFeeSats: items.reduce((sum, item) => sum + item.transaction.feeSats, 0n),
    totalRecoveryAmountSats: items.reduce(
      (sum, item) => sum + item.transaction.recoveryAmountSats,
      0n
    ),
  };
}

export function buildQuantumrootRecoveryTransaction({
  destinationAddress,
  feeRateSatsPerByte = DEFAULT_FEE_RATE,
  utxo,
  vault,
  vaultTokenCategory = '00'.repeat(32),
}: QuantumrootRecoveryBuildRequest): QuantumrootRecoveryBuildResult {
  if (utxo.token) {
    throw new Error('Quantumroot recovery currently supports BCH-only receive UTXOs.');
  }

  const inputValueSats = toBigIntSats(utxo.value ?? utxo.amount ?? 0);
  if (inputValueSats <= DUST_LIMIT) {
    throw new Error('Quantumroot recovery requires a funded BCH UTXO above dust.');
  }

  let feeSats = 200n * feeRateSatsPerByte;
  let compiled:
    | {
        rawTransaction: string;
        recoveryAmountSats: bigint;
        transactionByteLength: number;
      }
    | undefined;

  for (let iteration = 0; iteration < MAX_FEE_ITERATIONS; iteration += 1) {
    compiled = compileQuantumrootRecoveryTransaction({
      destinationAddress,
      feeSats,
      inputValueSats,
      outpointIndex: utxo.tx_pos,
      outpointTransactionHash: utxo.tx_hash,
      vault,
      vaultTokenCategory,
      unlockingScriptId: 'schnorr_spend',
    });

    const nextFee = deriveFeeFromBytes(
      compiled.transactionByteLength,
      feeRateSatsPerByte
    );
    if (nextFee === feeSats) {
      return {
        feeSats,
        rawTransaction: compiled.rawTransaction,
        recoveryAmountSats: compiled.recoveryAmountSats,
        transactionByteLength: compiled.transactionByteLength,
      };
    }
    feeSats = nextFee;
  }

  if (compiled === undefined) {
    throw new Error('Failed to compile Quantumroot recovery transaction.');
  }

  return {
    feeSats,
    rawTransaction: compiled.rawTransaction,
    recoveryAmountSats: compiled.recoveryAmountSats,
    transactionByteLength: compiled.transactionByteLength,
  };
}

export function buildQuantumrootQuantumLockRecoveryTransaction({
  destinationAddress,
  feeRateSatsPerByte = DEFAULT_FEE_RATE,
  utxo,
  vault,
  vaultTokenCategory = '00'.repeat(32),
}: QuantumrootRecoveryBuildRequest): QuantumrootRecoveryBuildResult {
  if (utxo.token) {
    throw new Error(
      'Quantum Lock recovery currently supports BCH-only Quantum Lock UTXOs.'
    );
  }

  const inputValueSats = toBigIntSats(utxo.value ?? utxo.amount ?? 0);
  if (inputValueSats <= DUST_LIMIT) {
    throw new Error('Quantum Lock recovery requires a funded BCH UTXO above dust.');
  }

  let feeSats = 220n * feeRateSatsPerByte;
  let compiled:
    | {
        rawTransaction: string;
        recoveryAmountSats: bigint;
        transactionByteLength: number;
      }
    | undefined;

  for (let iteration = 0; iteration < MAX_FEE_ITERATIONS; iteration += 1) {
    compiled = compileQuantumrootRecoveryTransaction({
      destinationAddress,
      feeSats,
      inputValueSats,
      outpointIndex: utxo.tx_pos,
      outpointTransactionHash: utxo.tx_hash,
      vault,
      vaultTokenCategory,
      unlockingScriptId: 'quantum_unlock',
    });

    const nextFee = deriveFeeFromBytes(
      compiled.transactionByteLength,
      feeRateSatsPerByte
    );
    if (nextFee === feeSats) {
      return {
        feeSats,
        rawTransaction: compiled.rawTransaction,
        recoveryAmountSats: compiled.recoveryAmountSats,
        transactionByteLength: compiled.transactionByteLength,
      };
    }
    feeSats = nextFee;
  }

  if (compiled === undefined) {
    throw new Error('Failed to compile Quantum Lock recovery transaction.');
  }

  return {
    feeSats,
    rawTransaction: compiled.rawTransaction,
    recoveryAmountSats: compiled.recoveryAmountSats,
    transactionByteLength: compiled.transactionByteLength,
  };
}
