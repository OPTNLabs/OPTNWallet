import {
  bigIntToVmNumber,
  binToHex,
  createCompilerBCH,
  createVirtualMachineBch2026,
  decodeAuthenticationInstructions,
  encodeAuthenticationInstructions,
  flattenBinArray,
  hash256,
  hexToBin,
  swapEndianness,
  importWalletTemplate,
  walletTemplateToCompilerConfiguration,
} from '@bitauth/libauth';
import { compileScriptRaw } from '@bitauth/libauth/build/lib/language/resolve.js';

import quantumrootTemplateJson from '../../../reference/quantumroot/quantumroot-schnorr-lm-ots-vault.json';
import type { UTXO } from '../types/types';
import { isPlainNftToken, type TokenCapability } from './cashtokens';
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

type RecoveryInput = {
  outpointIndex: number;
  outpointTransactionHash: Uint8Array;
  sequenceNumber: number;
  unlockingBytecode: Uint8Array;
};

type RecoveryOutput = {
  lockingBytecode: Uint8Array;
  token?: {
    amount: bigint;
    category: Uint8Array;
    nft?: {
      capability: TokenCapability;
      commitment: Uint8Array;
    };
  };
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

export const DEFAULT_FEE_RATE = 1n;
export const DUST_LIMIT = 546n;
export const MAX_FEE_ITERATIONS = 6;

export function toBigIntSats(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return BigInt(value);
  }
  return 0n;
}

export function deriveFeeFromBytes(byteLength: number, feeRateSatsPerByte: bigint) {
  return BigInt(byteLength) * feeRateSatsPerByte;
}

export function createQuantumrootCompiler() {
  return createCompilerBCH(walletTemplateToCompilerConfiguration(quantumrootTemplate));
}

export function createPatchedQuantumrootCompiler(vault: QuantumrootRecoveryVault) {
  return createCompilerBCH(
    walletTemplateToCompilerConfiguration(
      getQuantumrootTemplateWithOverrides({
        quantumPublicKey: vault.quantumPublicKey,
      })
    )
  );
}

export function encodeLeafSpendIndex(index: number) {
  return binToHex(bigIntToVmNumber(BigInt(index)));
}

export function normalizeTokenCategory(category: string) {
  return category.trim().replace(/^0x/i, '').toLowerCase();
}

export function formatVaultTokenCategoryForTemplate(category: string) {
  return `0x${swapEndianness(normalizeTokenCategory(category))}`;
}

export function toLibauthToken(token: NonNullable<UTXO['token']>) {
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

export function isQuantumrootAuthorizationToken(
  token: NonNullable<UTXO['token']> | null | undefined
) {
  return isPlainNftToken(token);
}

export function buildRecoveryCompilationData({
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

export function compileQuantumrootUnlockingBytecode({
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
    const errors = (result as { errors?: unknown }).errors;
    throw new Error(
      `Quantumroot recovery unlocking-bytecode compilation failed for ${scriptId}: ${JSON.stringify(
        errors
      )}`
    );
  }
  return result.bytecode;
}

export function compileQuantumrootRawScript({
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
    const errors = (result as { errors?: unknown }).errors;
    throw new Error(
      `Quantumroot raw-script compilation failed for ${scriptId}: ${JSON.stringify(
        errors
      )}`
    );
  }
  return result.bytecode;
}

export function verifyQuantumrootTransaction({
  sourceOutputs,
  transaction,
}: {
  sourceOutputs: RecoveryOutput[];
  transaction: RecoveryTransaction;
}) {
  return verifyQuantumrootTransactionInputs({
    inputIndexes: transaction.inputs.map((_, inputIndex) => inputIndex),
    sourceOutputs,
    transaction,
  });
}

export function verifyQuantumrootTransactionInputs({
  inputIndexes,
  sourceOutputs,
  transaction,
}: {
  inputIndexes: number[];
  sourceOutputs: RecoveryOutput[];
  transaction: RecoveryTransaction;
}) {
  const vm = createVirtualMachineBch2026();

  for (const inputIndex of Array.from(new Set(inputIndexes))) {
    if (
      !Number.isInteger(inputIndex) ||
      inputIndex < 0 ||
      inputIndex >= transaction.inputs.length
    ) {
      throw new Error(`Quantumroot verification requested invalid input index: ${inputIndex}`);
    }

    const verificationProgram = {
      inputIndex,
      sourceOutputs,
      transaction,
    } as Parameters<typeof vm.verify>[0];
    const verification = vm.verify(verificationProgram);
    if (verification !== true) {
      const trace = vm.debug(verificationProgram as Parameters<typeof vm.debug>[0]);
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

export function evaluateQuantumrootLockingScript({
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

export function createCorrectedQuantumLockSignedMessage({
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

export function buildManualQuantumUnlockingBytecode({
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

export function buildManualTokenSpendUnlockingBytecode({
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

export type {
  QuantumrootRecoveryVault,
  RecoveryInput,
  RecoveryOutput,
  RecoveryTransaction,
};
