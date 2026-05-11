import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeTransaction,
  hexToBin,
} from '@bitauth/libauth';
import type { UTXO } from '../types/types';
import { TOKEN_OUTPUT_SATS } from '../utils/constants';
import {
  QuantumrootRecoveryVault,
  buildRecoveryCompilationData,
  buildManualQuantumUnlockingBytecode,
  buildManualTokenSpendUnlockingBytecode,
  compileQuantumrootUnlockingBytecode,
  createQuantumrootCompiler,
  deriveFeeFromBytes,
  encodeLeafSpendIndex,
  normalizeTokenCategory,
  toBigIntSats,
  toLibauthToken,
  verifyQuantumrootTransaction,
  DEFAULT_FEE_RATE,
  DUST_LIMIT,
  MAX_FEE_ITERATIONS,
  type RecoveryTransaction,
} from './QuantumrootRecoveryHelpers';

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
