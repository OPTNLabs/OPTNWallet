import {
  binToHex,
  cashAddressToLockingBytecode,
  decodeTransaction,
  hexToBin,
  swapEndianness,
} from '@bitauth/libauth';

import ElectrumService from './ElectrumService';
import {
  normalizeTokenCategory,
  isQuantumrootAuthorizationToken,
  toBigIntSats,
} from './QuantumrootRecoveryHelpers';
import type { UTXO } from '../types/types';
import type { QuantumrootAuthorizedSpendBuildRequest } from './QuantumrootRecoveryService';

const TOKEN_DUST_SATS = 1000n;

export type QuantumrootAuthorizedSpendFulcrumValidationRequest =
  QuantumrootAuthorizedSpendBuildRequest & {
    rawTransaction: string;
  };

export type QuantumrootFulcrumValidationResult = {
  checkedAddresses: string[];
  checkedOutpoints: string[];
  inputCount: number;
  outputCount: number;
  transactionByteLength: number;
  validationMode: 'fulcrum-preflight';
};

type DecodedTransaction = Exclude<ReturnType<typeof decodeTransaction>, string>;

function toBigIntTokenAmount(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return BigInt(value);
  }
  return 0n;
}

function ensureDecodedTransaction(rawTransaction: string): DecodedTransaction {
  const decoded = decodeTransaction(hexToBin(rawTransaction));
  if (typeof decoded === 'string') {
    throw new Error(`Quantumroot authorized spend raw transaction is invalid: ${decoded}`);
  }
  return decoded;
}

function ensureCashAddressBytecode(address: string): Uint8Array {
  const lockingBytecode = cashAddressToLockingBytecode(address);
  if (typeof lockingBytecode === 'string') {
    throw new Error(lockingBytecode);
  }
  return lockingBytecode.bytecode;
}

function matchesRequestedTxHash(decodedOutpointHash: Uint8Array, requestedTxHash: string) {
  const decodedHex = binToHex(decodedOutpointHash);
  return (
    decodedHex === requestedTxHash ||
    swapEndianness(decodedHex) === requestedTxHash
  );
}

function ensureRequestedInputOrder({
  controlTokenUtxo,
  receiveUtxos,
  transaction,
}: QuantumrootAuthorizedSpendFulcrumValidationRequest & {
  transaction: DecodedTransaction;
}) {
  const expectedInputs = [controlTokenUtxo, ...receiveUtxos];

  if (transaction.inputs.length !== expectedInputs.length) {
    throw new Error(
      `Quantumroot authorized spend expected ${expectedInputs.length} inputs, found ${transaction.inputs.length}.`
    );
  }

  transaction.inputs.forEach((input, index) => {
    const requested = expectedInputs[index];
    if (
      !matchesRequestedTxHash(input.outpointTransactionHash, requested.tx_hash) ||
      input.outpointIndex !== requested.tx_pos
    ) {
      throw new Error(
        `Quantumroot authorized spend input ${index} does not match the requested outpoint.`
      );
    }
    if (input.sequenceNumber !== 0) {
      throw new Error(
        `Quantumroot authorized spend input ${index} must use sequence 0.`
      );
    }
  });
}

function ensureRequestedOutputs({
  destinationAddress,
  controlTokenUtxo,
  successorQuantumLockLockingBytecode,
  successorQuantumLockAddress,
  transaction,
}: QuantumrootAuthorizedSpendFulcrumValidationRequest & {
  transaction: DecodedTransaction;
}) {
  if (transaction.outputs.length !== 2) {
    throw new Error(
      `Quantumroot authorized spend expected 2 outputs, found ${transaction.outputs.length}.`
    );
  }

  const destinationLockingBytecode = ensureCashAddressBytecode(destinationAddress);
  const successorLockingBytecode = ensureCashAddressBytecode(
    successorQuantumLockAddress
  );
  if (
    binToHex(successorLockingBytecode) !==
    binToHex(successorQuantumLockLockingBytecode)
  ) {
    throw new Error(
      'Quantumroot authorized spend successor Quantum Lock address does not match the provided locking bytecode.'
    );
  }

  const controlValueSats = toBigIntSats(
    controlTokenUtxo.value ?? controlTokenUtxo.amount ?? 0
  );
  const expectedSuccessorValue =
    controlValueSats >= TOKEN_DUST_SATS ? controlValueSats : TOKEN_DUST_SATS;

  const [successorOutput, destinationOutput] = transaction.outputs;
  if (binToHex(successorOutput.lockingBytecode) !== binToHex(successorLockingBytecode)) {
    throw new Error(
      'Quantumroot authorized spend successor output does not match the requested Quantum Lock address.'
    );
  }

  const outputToken = successorOutput.token;
  if (!outputToken) {
    throw new Error('Quantumroot authorized spend successor output is missing its token.');
  }

  if (successorOutput.valueSatoshis !== expectedSuccessorValue) {
    throw new Error(
      `Quantumroot authorized spend successor output value does not match the expected control-token value (${expectedSuccessorValue.toString()} sats).`
    );
  }

  if (outputToken.amount !== toBigIntTokenAmount(controlTokenUtxo.token?.amount)) {
    throw new Error(
      'Quantumroot authorized spend successor output token amount does not match the requested control token.'
    );
  }

  if (binToHex(outputToken.category) !== swapEndianness(normalizeTokenCategory(controlTokenUtxo.token!.category))) {
    throw new Error(
      'Quantumroot authorized spend successor output token category does not match the requested control token.'
    );
  }

  if (
    outputToken.nft?.capability !== controlTokenUtxo.token?.nft?.capability ||
    binToHex(outputToken.nft?.commitment ?? new Uint8Array()) !==
      binToHex(hexToBin(controlTokenUtxo.token?.nft?.commitment ?? ''))
  ) {
    throw new Error(
      'Quantumroot authorized spend successor output NFT state does not match the requested control token.'
    );
  }

  if (binToHex(destinationOutput.lockingBytecode) !== binToHex(destinationLockingBytecode)) {
    throw new Error(
      'Quantumroot authorized spend destination output does not match the requested destination address.'
    );
  }

  if (destinationOutput.valueSatoshis <= 0n) {
    throw new Error('Quantumroot authorized spend destination output must be funded.');
  }
}

function groupLiveUtxos(utxosByAddress: Record<string, UTXO[]>) {
  return Object.fromEntries(
    Object.entries(utxosByAddress).map(([address, utxos]) => [
      address,
      new Map(
        utxos
          .filter(
            (utxo): utxo is UTXO =>
              typeof utxo.tx_hash === 'string' &&
              typeof utxo.tx_pos === 'number'
          )
          .map((utxo) => [`${utxo.tx_hash}:${utxo.tx_pos}`, utxo])
      ),
    ])
  ) as Record<string, Map<string, UTXO>>;
}

function ensureLiveUtxos({
  controlTokenUtxo,
  receiveUtxos,
  vault,
  liveUtxosByAddress,
}: QuantumrootAuthorizedSpendFulcrumValidationRequest & {
  liveUtxosByAddress: Record<string, Map<string, UTXO>>;
}) {
  const controlLive = liveUtxosByAddress[vault.quantumLockAddress]?.get(
    `${controlTokenUtxo.tx_hash}:${controlTokenUtxo.tx_pos}`
  );
  if (!controlLive) {
    throw new Error(
      'Quantumroot authorized spend control token UTXO is not currently visible on the chipnet entry-point.'
    );
  }

  const liveControlToken = controlLive.token as
    | {
        amount?: unknown;
        category?: unknown;
        nft?: { capability?: unknown; commitment?: unknown };
      }
    | undefined;
  if (!liveControlToken) {
    throw new Error('Quantumroot authorized spend control token UTXO is missing token data.');
  }
  if (!isQuantumrootAuthorizationToken(controlTokenUtxo.token)) {
    throw new Error(
      'Quantumroot authorized spend control token UTXO must be a plain NFT with no capability.'
    );
  }
  if (normalizeTokenCategory(String(liveControlToken.category ?? '')) !== normalizeTokenCategory(controlTokenUtxo.token!.category)) {
    throw new Error(
      'Quantumroot authorized spend control token category does not match chipnet state.'
    );
  }

  for (const [index, receiveUtxo] of receiveUtxos.entries()) {
    const liveReceive = liveUtxosByAddress[vault.receiveAddress]?.get(
      `${receiveUtxo.tx_hash}:${receiveUtxo.tx_pos}`
    );
    if (!liveReceive) {
      throw new Error(
        `Quantumroot authorized spend receive UTXO ${index} is not currently visible on the chipnet entry-point.`
      );
    }

    if (index === 0) {
      const liveReceiveToken = liveReceive.token as
        | {
            amount?: unknown;
            category?: unknown;
            nft?: { capability?: unknown; commitment?: unknown };
          }
        | undefined;
      if (!liveReceiveToken) {
        throw new Error(
          'Quantumroot authorized spend first receive UTXO must remain tokenized on chipnet.'
        );
      }
      if (!isQuantumrootAuthorizationToken(receiveUtxo.token)) {
        throw new Error(
          'Quantumroot authorized spend first receive UTXO must be a plain NFT with no capability.'
        );
      }
      if (
        normalizeTokenCategory(String(liveReceiveToken.category ?? '')) !==
        normalizeTokenCategory(receiveUtxo.token!.category)
      ) {
        throw new Error(
          'Quantumroot authorized spend first receive UTXO token category does not match chipnet state.'
        );
      }
    } else if (liveReceive.token) {
      throw new Error(
        'Quantumroot authorized spend additional receive UTXOs must remain BCH-only on chipnet.'
      );
    }
  }
}

export async function validateQuantumrootAuthorizedSpendAgainstFulcrum(
  request: QuantumrootAuthorizedSpendFulcrumValidationRequest
): Promise<QuantumrootFulcrumValidationResult> {
  const decoded = ensureDecodedTransaction(request.rawTransaction);
  ensureRequestedInputOrder({ ...request, transaction: decoded });
  ensureRequestedOutputs({ ...request, transaction: decoded });

  const liveAddresses = Array.from(
    new Set([
      request.vault.quantumLockAddress,
      request.vault.receiveAddress,
    ])
  );
  const liveUtxosByAddress = groupLiveUtxos(
    await ElectrumService.getUTXOsMany(liveAddresses)
  );
  ensureLiveUtxos({
    ...request,
    liveUtxosByAddress,
  });

  return {
    checkedAddresses: liveAddresses,
    checkedOutpoints: [
      request.controlTokenUtxo,
      ...request.receiveUtxos,
    ].map((utxo) => `${utxo.tx_hash}:${utxo.tx_pos}`),
    inputCount: decoded.inputs.length,
    outputCount: decoded.outputs.length,
    transactionByteLength: hexToBin(request.rawTransaction).length,
    validationMode: 'fulcrum-preflight',
  };
}
