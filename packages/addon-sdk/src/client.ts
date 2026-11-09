import { ADDON_SDK_METHODS, type AddonSDKMethod } from './contract.js';
import {
  parseAddresses,
  parseAuditTrail,
  parseBoolean,
  parseContext,
  parseContractView,
  parseInfo,
  parseOperation,
  parseProposal,
  parseSignedMessage,
  parseString,
  parseUtxos,
  parseWalletUtxos,
} from './schema.js';
import {
  AddonSDKError,
  type AddonTransport,
  type AddonTransportRequestOptions,
} from './transport.js';
import type {
  AddonAddress,
  AddonCashTokenIntent,
  AddonExecutionOperation,
  AddonHttpRequest,
  AddonPolicyAuditEvent,
  AddonSDKInfo,
  AddonSignedMessageResponse,
  AddonTransactionOutput,
  AddonTransactionProposal,
  AddonUtxo,
} from './types.js';
import { ADDON_SDK_LIMITS } from './contract.js';
import {
  validateCashScriptArtifact,
  validateCashScriptValues,
  validateCashScriptFunctionArguments,
  validateCashScriptFunctionCall,
  validateCashScriptConstructorCall,
  validateContractType,
} from './cashscript.js';
import type {
  AddonCashScriptArtifact,
  AddonCashScriptValue,
  AddonContractType,
  AddonContractView,
  AddonContractProposalRequest,
} from './types.js';

const MAX_REQUEST_PARAMS_BYTES = 64 * 1024;
const MAX_IDENTIFIER_LENGTH = 256;

function validateIdentifier(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new AddonSDKError({
      code: 'INVALID_REQUEST',
      message: `${label} must contain between 1 and ${MAX_IDENTIFIER_LENGTH} characters`,
    });
  }
}

function validateIdentifierValue(value: string, label: string): string {
  validateIdentifier(value, label);
  return value;
}

function assertBoundedRequestParams(value: unknown, method: string): void {
  if (value === undefined) return;
  let encoded: string;
  try {
    encoded = JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item
    );
  } catch {
    throw new AddonSDKError({
      code: 'INVALID_REQUEST',
      message: `Parameters for ${method} are not serializable`,
    });
  }
  if (
    typeof encoded !== 'string' ||
    encoded.length > MAX_REQUEST_PARAMS_BYTES
  ) {
    if (typeof encoded !== 'string') {
      throw new AddonSDKError({
        code: 'INVALID_REQUEST',
        message: `Parameters for ${method} are not serializable`,
      });
    }
    throw new AddonSDKError({
      code: 'RESOURCE_LIMIT',
      message: `Parameters for ${method} exceed the SDK limit`,
    });
  }
}

function validateIdempotencyKey(value: string | undefined): void {
  if (
    value !== undefined &&
    (typeof value !== 'string' ||
      value.trim().length === 0 ||
      value.length > ADDON_SDK_LIMITS.maxIdempotencyKeyLength)
  ) {
    throw new AddonSDKError({
      code: 'INVALID_REQUEST',
      message: `Idempotency key must contain between 1 and ${ADDON_SDK_LIMITS.maxIdempotencyKeyLength} characters`,
    });
  }
}

export type AddonWalletClient = {
  meta: {
    getInfo(options?: AddonTransportRequestOptions): Promise<AddonSDKInfo>;
    getAuditTrail(
      options?: AddonTransportRequestOptions
    ): Promise<AddonPolicyAuditEvent[]>;
  };
  wallet: {
    getContext(
      options?: AddonTransportRequestOptions
    ): Promise<{ walletId: number; network: string | null }>;
    listAddresses(
      options?: AddonTransportRequestOptions
    ): Promise<AddonAddress[]>;
    getPrimaryAddress(
      options?: AddonTransportRequestOptions
    ): Promise<string | null>;
    toTokenAddress(
      address: string,
      options?: AddonTransportRequestOptions
    ): Promise<string>;
  };
  utxos: {
    listForAddress(
      address: string,
      options?: AddonTransportRequestOptions
    ): Promise<AddonUtxo[]>;
    listForWallet(
      options?: AddonTransportRequestOptions
    ): Promise<{ allUtxos: AddonUtxo[]; tokenUtxos: AddonUtxo[] }>;
    refreshAndStore(
      address: string,
      options?: AddonTransportRequestOptions
    ): Promise<AddonUtxo[]>;
  };
  bcmr: {
    getTokenMetadata(
      category: string,
      options?: AddonTransportRequestOptions
    ): Promise<unknown | null>;
    getTokenMetadataState(
      category: string,
      options?: AddonTransportRequestOptions
    ): Promise<unknown | null>;
  };
  tokenIndex: {
    listTokenHolders(
      args: { category: string; limit?: number; cursor?: string },
      options?: AddonTransportRequestOptions
    ): Promise<unknown>;
  };
  chain: {
    getLatestBlock(options?: AddonTransportRequestOptions): Promise<unknown>;
    queryUnspentByLockingBytecode(
      lockingBytecodeHex: string,
      tokenId: string,
      options?: AddonTransportRequestOptions
    ): Promise<unknown>;
  };
  tx: {
    propose(
      args: {
        inputs: AddonUtxo[];
        outputs: AddonTransactionOutput[];
        expiresInMs?: number;
        idempotencyKey?: string;
        tokenIntent?: AddonCashTokenIntent;
      },
      options?: AddonTransportRequestOptions
    ): Promise<AddonTransactionProposal>;
    getProposal(
      proposalId: string,
      options?: AddonTransportRequestOptions
    ): Promise<AddonTransactionProposal>;
    requestExecution(
      args: {
        proposalId: string;
        mode?: 'wallet-submit';
        idempotencyKey?: string;
      },
      options?: AddonTransportRequestOptions
    ): Promise<AddonExecutionOperation>;
    getOperation(
      operationId: string,
      options?: AddonTransportRequestOptions
    ): Promise<AddonExecutionOperation>;
    waitForOperation(
      operationId: string,
      options?: AddonTransportRequestOptions & {
        pollIntervalMs?: number;
        timeoutMs?: number;
        signal?: AbortSignal;
      }
    ): Promise<AddonExecutionOperation>;
  };
  contracts: {
    instantiate(
      args: {
        artifact: AddonCashScriptArtifact;
        constructorArgs?: AddonCashScriptValue[];
        contractType?: AddonContractType;
      },
      options?: AddonTransportRequestOptions
    ): Promise<AddonContractView>;
    deriveAddress(
      args: {
        artifact: AddonCashScriptArtifact;
        constructorArgs?: AddonCashScriptValue[];
        contractType?: AddonContractType;
      },
      options?: AddonTransportRequestOptions
    ): Promise<string>;
    deriveLockingBytecode(
      args: {
        artifact: AddonCashScriptArtifact;
        constructorArgs?: AddonCashScriptValue[];
        contractType?: AddonContractType;
      },
      options?: AddonTransportRequestOptions
    ): Promise<string>;
    propose(
      args: AddonContractProposalRequest,
      options?: AddonTransportRequestOptions
    ): Promise<AddonTransactionProposal>;
  };
  signing: {
    signMessage(
      args: { address: string; message: string },
      options?: AddonTransportRequestOptions
    ): Promise<AddonSignedMessageResponse>;
  };
  http: {
    fetchJson<T = unknown>(
      request: AddonHttpRequest,
      options?: AddonTransportRequestOptions
    ): Promise<T>;
  };
  ui: {
    confirmSensitiveAction(
      args: {
        title: string;
        description?: string;
        risk?: 'low' | 'medium' | 'high';
      },
      options?: AddonTransportRequestOptions
    ): Promise<boolean>;
  };
};

const TERMINAL_OPERATION_STATUSES = new Set(['confirmed', 'rejected']);

function abortError(): Error {
  return new Error('Operation wait aborted');
}

function assertMethod(method: AddonSDKMethod): AddonSDKMethod {
  const [module, name] = method.split('.') as [
    keyof typeof ADDON_SDK_METHODS,
    string,
  ];
  if (
    !(ADDON_SDK_METHODS[module] as readonly string[] | undefined)?.includes(
      name
    )
  ) {
    throw new Error(`Unsupported SDK method: ${method}`);
  }
  return method;
}

export function createAddonWalletClient(
  transport: AddonTransport
): AddonWalletClient {
  const call = async <T>(
    method: AddonSDKMethod,
    params: unknown,
    parse: (value: unknown) => T,
    options?: AddonTransportRequestOptions
  ): Promise<T> => {
    const validatedMethod = assertMethod(method);
    assertBoundedRequestParams(params, validatedMethod);
    return transport.request(validatedMethod, params, options).then(parse);
  };

  return {
    meta: {
      getInfo: (options) => call('meta.getInfo', undefined, parseInfo, options),
      getAuditTrail: (options) =>
        call('meta.getAuditTrail', undefined, parseAuditTrail, options),
    },
    wallet: {
      getContext: (options) =>
        call('wallet.getContext', undefined, parseContext, options),
      listAddresses: (options) =>
        call('wallet.listAddresses', undefined, parseAddresses, options),
      getPrimaryAddress: (options) =>
        call(
          'wallet.getPrimaryAddress',
          undefined,
          (value) =>
            value === null ? null : parseString(value, 'primary address'),
          options
        ),
      toTokenAddress: (address, options) =>
        call(
          'wallet.toTokenAddress',
          { address },
          (value) => parseString(value, 'token address'),
          options
        ),
    },
    utxos: {
      listForAddress: (address, options) =>
        call('utxos.listForAddress', { address }, parseUtxos, options),
      listForWallet: (options) =>
        call('utxos.listForWallet', undefined, parseWalletUtxos, options),
      refreshAndStore: (address, options) =>
        call('utxos.refreshAndStore', { address }, parseUtxos, options),
    },
    bcmr: {
      getTokenMetadata: (category, options) =>
        call(
          'bcmr.getTokenMetadata',
          { category },
          (value) => (value === null ? null : structuredClone(value)),
          options
        ),
      getTokenMetadataState: (category, options) =>
        call(
          'bcmr.getTokenMetadataState',
          { category },
          (value) => (value === null ? null : structuredClone(value)),
          options
        ),
    },
    tokenIndex: {
      listTokenHolders: (args, options) =>
        call('tokenIndex.listTokenHolders', args, structuredClone, options),
    },
    chain: {
      getLatestBlock: (options) =>
        call('chain.getLatestBlock', undefined, structuredClone, options),
      queryUnspentByLockingBytecode: (lockingBytecodeHex, tokenId, options) =>
        call(
          'chain.queryUnspentByLockingBytecode',
          { lockingBytecodeHex, tokenId },
          structuredClone,
          options
        ),
    },
    tx: {
      propose: (args, options) => {
        validateIdempotencyKey(args.idempotencyKey);
        return call('tx.propose', args, parseProposal, options);
      },
      getProposal: async (proposalId, options) => {
        validateIdentifier(proposalId, 'Proposal ID');
        return call('tx.getProposal', { proposalId }, parseProposal, options);
      },
      requestExecution: (args, options) => {
        validateIdempotencyKey(args.idempotencyKey);
        return call('tx.requestExecution', args, parseOperation, options);
      },
      getOperation: async (operationId, options) => {
        validateIdentifier(operationId, 'Operation ID');
        return call(
          'tx.getOperation',
          { operationId },
          parseOperation,
          options
        );
      },
      waitForOperation: async (operationId, options = {}) => {
        validateIdentifier(operationId, 'Operation ID');
        const {
          pollIntervalMs: requestedPollInterval,
          timeoutMs: requestedTimeout,
          ...transportOptions
        } = options;
        if (
          (requestedPollInterval !== undefined &&
            (!Number.isFinite(requestedPollInterval) ||
              requestedPollInterval <= 0)) ||
          (requestedTimeout !== undefined &&
            (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0))
        ) {
          throw new AddonSDKError({
            code: 'INVALID_REQUEST',
            message: 'Operation polling controls must be finite and positive',
          });
        }
        const pollIntervalMs = Math.max(50, requestedPollInterval ?? 1000);
        const timeoutMs = Math.max(pollIntervalMs, requestedTimeout ?? 120_000);
        const started = Date.now();
        while (true) {
          if (options.signal?.aborted) throw abortError();
          const operation = await call(
            'tx.getOperation',
            { operationId },
            parseOperation,
            transportOptions
          );
          if (TERMINAL_OPERATION_STATUSES.has(operation.status)) {
            return operation;
          }
          const elapsed = Date.now() - started;
          if (elapsed >= timeoutMs) {
            throw new Error(`Timed out waiting for operation ${operationId}`);
          }
          await new Promise<void>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout>;
            const onAbort = () => {
              clearTimeout(timer);
              options.signal?.removeEventListener('abort', onAbort);
              reject(abortError());
            };
            timer = setTimeout(
              () => {
                options.signal?.removeEventListener('abort', onAbort);
                resolve();
              },
              Math.min(pollIntervalMs, timeoutMs - elapsed)
            );
            options.signal?.addEventListener('abort', onAbort, { once: true });
          });
        }
      },
    },
    contracts: {
      instantiate: (args, options) => {
        const artifact = validateCashScriptArtifact(args.artifact);
        const normalized = {
          artifact,
          constructorArgs: validateCashScriptConstructorCall(
            artifact,
            validateCashScriptValues(
              args.constructorArgs ?? [],
              'constructorArgs'
            )
          ),
          contractType: validateContractType(args.contractType ?? 'p2sh32'),
        };
        return call(
          'contracts.instantiate',
          normalized,
          (value) => parseContractView(value),
          options
        );
      },
      deriveAddress: (args, options) => {
        const artifact = validateCashScriptArtifact(args.artifact);
        const normalized = {
          artifact,
          constructorArgs: validateCashScriptConstructorCall(
            artifact,
            validateCashScriptValues(
              args.constructorArgs ?? [],
              'constructorArgs'
            )
          ),
          contractType: validateContractType(args.contractType ?? 'p2sh32'),
        };
        return call(
          'contracts.deriveAddress',
          normalized,
          (value) => parseString(value, 'contract address'),
          options
        );
      },
      deriveLockingBytecode: (args, options) => {
        const artifact = validateCashScriptArtifact(args.artifact);
        const normalized = {
          artifact,
          constructorArgs: validateCashScriptConstructorCall(
            artifact,
            validateCashScriptValues(
              args.constructorArgs ?? [],
              'constructorArgs'
            )
          ),
          contractType: validateContractType(args.contractType ?? 'p2sh32'),
        };
        return call(
          'contracts.deriveLockingBytecode',
          normalized,
          (value) => parseString(value, 'contract locking bytecode'),
          options
        );
      },
      propose: (args, options) => {
        validateIdempotencyKey(args.idempotencyKey);
        const artifact = validateCashScriptArtifact(args.artifact);
        const constructorArgs = validateCashScriptConstructorCall(
          artifact,
          validateCashScriptValues(
            args.constructorArgs ?? [],
            'constructorArgs'
          )
        );
        const functionName = validateIdentifierValue(
          args.function.name,
          'Contract function name'
        );
        const functionArgs = validateCashScriptFunctionArguments(
          args.function.args,
          'function args'
        );
        validateCashScriptFunctionCall(artifact, functionName, functionArgs);
        const contractInputIndexes = args.contractInputIndexes;
        if (
          (args.inputs.length > 0 && contractInputIndexes.length === 0) ||
          contractInputIndexes.some(
            (index) =>
              !Number.isInteger(index) ||
              index < 0 ||
              index >= args.inputs.length
          ) ||
          new Set(contractInputIndexes).size !== contractInputIndexes.length
        ) {
          throw new Error(
            'contractInputIndexes must contain unique input indexes'
          );
        }
        const normalized = {
          artifact,
          contractId: args.contract.contractId,
          contractAddress: args.contract.address ?? args.contract.tokenAddress,
          contractLockingBytecode: args.contract.lockingBytecode,
          constructorArgs,
          functionName,
          functionArgs,
          inputs: args.inputs,
          outputs: args.outputs,
          expiresInMs: args.expiresInMs,
          idempotencyKey: args.idempotencyKey,
          signerBindings: functionArgs
            .filter(
              (
                arg
              ): arg is {
                type: 'sig';
                signer: { address: string; purpose: 'wallet-spend' };
              } => arg.type === 'sig' && 'signer' in arg
            )
            .map((arg) => arg.signer),
          contractType: validateContractType(args.contract.contractType),
          contractInputIndexes: [...contractInputIndexes].sort((a, b) => a - b),
          function: {
            name: validateIdentifierValue(
              args.function.name,
              'Contract function name'
            ),
            args: validateCashScriptFunctionArguments(
              args.function.args,
              'function args'
            ),
          },
        };
        return call('contracts.propose', normalized, parseProposal, options);
      },
    },
    signing: {
      signMessage: (args, options) => {
        if (
          !args ||
          typeof args.address !== 'string' ||
          args.address.trim().length === 0 ||
          args.address.length > MAX_IDENTIFIER_LENGTH
        ) {
          throw new AddonSDKError({
            code: 'INVALID_REQUEST',
            message: `Signing address must contain between 1 and ${MAX_IDENTIFIER_LENGTH} characters`,
          });
        }
        if (
          typeof args.message !== 'string' ||
          args.message.length === 0 ||
          args.message.length > ADDON_SDK_LIMITS.maxMessageLength
        ) {
          throw new AddonSDKError({
            code: 'INVALID_REQUEST',
            message: `Message must contain between 1 and ${ADDON_SDK_LIMITS.maxMessageLength} characters`,
          });
        }
        return call('signing.signMessage', args, parseSignedMessage, options);
      },
    },
    http: {
      fetchJson: <T = unknown>(
        request: AddonHttpRequest,
        options?: AddonTransportRequestOptions
      ): Promise<T> =>
        call<T>(
          'http.fetchJson',
          request,
          (value) => structuredClone(value) as T,
          options
        ),
    },
    ui: {
      confirmSensitiveAction: (args, options) =>
        call(
          'ui.confirmSensitiveAction',
          args,
          (value) => parseBoolean(value, 'confirmation result'),
          options
        ),
    },
  };
}
