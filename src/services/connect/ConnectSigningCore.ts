/** Platform glue only: encode SDK values for the shared Rust signing core. */
import type { CompilationContextBCH, Output } from '@bitauth/libauth';
import {
  connectP2pkhLock,
  connectPublicKey,
  connectSignInput,
  connectSignP2pkh,
  connectSigningSerialization,
} from '../../wasm/optn-core';

export const CONNECT_ALL_OUTPUTS = 0x41;
export const CONNECT_ALL_OUTPUTS_ALL_UTXOS = 0x61;

function output(value: Output) {
  if (
    typeof value.valueSatoshis !== 'bigint' ||
    (value.token && typeof value.token.amount !== 'bigint')
  ) {
    throw new Error('Connector SDK amounts must be bigint values');
  }
  return {
    valueSatoshis: value.valueSatoshis.toString(),
    lockingBytecode: Array.from(value.lockingBytecode),
    token: value.token
      ? {
          category: Array.from(value.token.category),
          amount: value.token.amount.toString(),
          nft: value.token.nft
            ? {
                capability: value.token.nft.capability,
                commitment: Array.from(value.token.nft.commitment),
              }
            : null,
        }
      : null,
  };
}

function contextJson(context: CompilationContextBCH): string {
  return JSON.stringify({
    inputIndex: context.inputIndex,
    transaction: {
      version: context.transaction.version,
      locktime: context.transaction.locktime,
      inputs: context.transaction.inputs.map((input) => ({
        outpointTransactionHash: Array.from(input.outpointTransactionHash),
        outpointIndex: input.outpointIndex,
        sequenceNumber: input.sequenceNumber,
      })),
      outputs: context.transaction.outputs.map(output),
    },
    sourceOutputs: context.sourceOutputs.map(output),
  });
}

export function connectorSigningSerialization(
  context: CompilationContextBCH,
  coveredBytecode: Uint8Array,
  mode: number
): Uint8Array {
  return connectSigningSerialization(
    contextJson(context),
    coveredBytecode,
    mode
  );
}

export function signConnectorInput(
  context: CompilationContextBCH,
  privateKey: Uint8Array,
  coveredBytecode: Uint8Array,
  mode: number
): Uint8Array {
  return connectSignInput(
    contextJson(context),
    privateKey,
    coveredBytecode,
    mode
  );
}

export function connectorPublicKey(privateKey: Uint8Array): Uint8Array {
  return connectPublicKey(privateKey);
}

export function connectorP2pkhLock(publicKey: Uint8Array): Uint8Array {
  return connectP2pkhLock(publicKey);
}

export function signConnectorP2pkh(
  context: CompilationContextBCH,
  privateKey: Uint8Array,
  mode = CONNECT_ALL_OUTPUTS_ALL_UTXOS
): Uint8Array {
  return connectSignP2pkh(contextJson(context), privateKey, mode);
}
