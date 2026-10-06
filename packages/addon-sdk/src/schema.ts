import type {
  AddonCashTokenIntent,
  AddonExecutionOperation,
  AddonPolicyAuditEvent,
  AddonSDKInfo,
  AddonSignedMessageResponse,
  AddonToken,
  AddonTransactionOutput,
  AddonTransactionProposal,
  AddonUtxo,
  AddonContractView,
} from './types.js';
import { AddonSDKError } from './transport.js';
import { ADDON_SDK_CAPABILITIES, ADDON_SDK_METHODS } from './contract.js';

const MAX_CASHTOKEN_AMOUNT = 9_223_372_036_854_775_807n;
const MAX_NFT_COMMITMENT_HEX_LENGTH = 80;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label}`,
    });
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label}`,
    });
  }
  return value;
}

function boundedString(value: unknown, label: string, max = 256): string {
  const parsed = stringValue(value, label);
  if (parsed.length === 0 || parsed.length > max) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label}`,
    });
  }
  return parsed;
}

function timestampString(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label}`,
    });
  }
  return parsed;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label}`,
    });
  }
  return value;
}

function networkValue(value: unknown, label: string): 'mainnet' | 'chipnet' | null {
  if (value === null) return null;
  if (value !== 'mainnet' && value !== 'chipnet') {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label}`,
    });
  }
  return value;
}

function walletIdValue(value: unknown, label: string): number {
  const parsed = numberValue(value, label);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label}`,
    });
  }
  return parsed;
}

function nullableRevisionValue(value: unknown, label: string): number | null {
  if (value === null) return null;
  const parsed = numberValue(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label}`,
    });
  }
  return parsed;
}

function nonNegativeIntegerValue(value: unknown, label: string): number {
  const parsed = numberValue(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label}`,
    });
  }
  return parsed;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

function amountValue(value: unknown, label: string): string | number | bigint {
  if (
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^\d+$/.test(value))
  ) {
    return value;
  }
  throw new AddonSDKError({
    code: 'VALIDATION_FAILED',
    message: `Wallet returned an invalid ${label}`,
  });
}

function parseCategory(value: unknown, label: string): string {
  const category = stringValue(value, `${label} category`).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(category)) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label} category`,
    });
  }
  return category;
}

function parseCommitment(value: unknown, label: string): string {
  const commitment = stringValue(value, `${label} commitment`).toLowerCase();
  if (
    !/^[0-9a-f]*$/.test(commitment) ||
    commitment.length % 2 !== 0 ||
    commitment.length > MAX_NFT_COMMITMENT_HEX_LENGTH
  ) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label} commitment`,
    });
  }
  return commitment;
}

function parseNft(
  value: unknown,
  label: string
): NonNullable<AddonToken['nft']> {
  const nftRecord = record(value, `${label} NFT`);
  const capability = nftRecord.capability;
  if (
    capability !== 'none' &&
    capability !== 'mutable' &&
    capability !== 'minting'
  ) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label} capability`,
    });
  }
  return {
    capability,
    commitment: parseCommitment(nftRecord.commitment, label),
  };
}

function parseToken(value: unknown, label: string): AddonToken {
  const token = record(value, label);
  const nftValue = token.nft;
  let nft: AddonToken['nft'] = undefined;
  if (nftValue !== undefined && nftValue !== null) {
    nft = parseNft(nftValue, label);
  }
  const amount = amountValue(token.amount, `${label} amount`);
  let amountBigInt: bigint;
  try {
    amountBigInt = BigInt(amount);
  } catch {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label} amount`,
    });
  }
  if (
    amountBigInt < 0n ||
    amountBigInt > MAX_CASHTOKEN_AMOUNT ||
    (nft === undefined && amountBigInt === 0n)
  ) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label} amount`,
    });
  }
  return {
    amount,
    category: parseCategory(token.category, label),
    ...(nft ? { nft } : {}),
  };
}

function parsePositiveTokenAmount(value: unknown, label: string): string {
  const amount = stringValue(value, label);
  let numeric: bigint;
  try {
    numeric = BigInt(amount);
  } catch {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label}`,
    });
  }
  if (
    numeric <= 0n ||
    numeric > MAX_CASHTOKEN_AMOUNT ||
    !/^\d+$/.test(amount)
  ) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned an invalid ${label}`,
    });
  }
  return amount;
}

function parseOutput(value: unknown): AddonTransactionOutput {
  const output = record(value, 'proposal output');
  if (Array.isArray(output.opReturn)) {
    return {
      opReturn: output.opReturn.map((chunk) =>
        stringValue(chunk, 'OP_RETURN chunk')
      ),
    };
  }
  return {
    recipientAddress: stringValue(
      output.recipientAddress,
      'proposal recipient address'
    ),
    amount: amountValue(output.amount, 'proposal output amount'),
    ...(output.token === undefined
      ? {}
      : { token: parseToken(output.token, 'proposal token') }),
  };
}

function parseTokenIntent(value: unknown): AddonCashTokenIntent | undefined {
  if (value === undefined) return undefined;
  const intent = record(value, 'token intent');
  const kind = intent.kind;
  if (kind === 'transfer') return { kind };
  const category = parseCategory(intent.category, 'token intent');
  if (kind === 'mint-fungible') {
    return {
      kind,
      category,
      amount: parsePositiveTokenAmount(intent.amount, 'token mint amount'),
      ...(intent.nft === undefined
        ? {}
        : {
            nft: parseNft(intent.nft, 'token mint'),
          }),
    };
  }
  if (kind === 'mint-nft') {
    const nft = parseNft(
      { capability: intent.capability, commitment: intent.commitment },
      'token mint'
    );
    return { kind, category, ...nft };
  }
  if (kind === 'mutate-nft') {
    const source = parseNft(intent.source, 'token mutation source');
    const target = parseNft(intent.target, 'token mutation target');
    return { kind, category, source, target };
  }
  if (kind === 'burn') {
    return {
      kind,
      category,
      ...(intent.amount === undefined
        ? {}
        : {
            amount: parsePositiveTokenAmount(
              intent.amount,
              'token burn amount'
            ),
          }),
      ...(intent.nft === undefined
        ? {}
        : { nft: parseNft(intent.nft, 'token burn') }),
    };
  }
  throw new AddonSDKError({
    code: 'VALIDATION_FAILED',
    message: 'Wallet returned an unsupported token intent',
  });
}

function safeClone<T>(value: T): T {
  return structuredClone(value);
}

export function parseContractView(value: unknown): AddonContractView {
  const contract = record(value, 'contract view');
  const contractType = contract.contractType;
  if (contractType !== 'p2sh20' && contractType !== 'p2sh32' && contractType !== 'p2s') {
    throw new AddonSDKError({ code: 'VALIDATION_FAILED', message: 'Wallet returned an invalid contract type' });
  }
  const bytesize = nonNegativeIntegerValue(contract.bytesize, 'contract byte size');
  const opcount = nonNegativeIntegerValue(contract.opcount, 'contract opcode count');
  const compiler = record(contract.compiler, 'contract compiler');
  const result: AddonContractView = {
    contractId: boundedString(contract.contractId, 'contract ID'),
    contractName: boundedString(contract.contractName, 'contract name'),
    contractType,
    lockingBytecode: boundedString(contract.lockingBytecode, 'contract locking bytecode', 2 * 1024 * 1024),
    bytecode: boundedString(contract.bytecode, 'contract bytecode', 2 * 1024 * 1024),
    bytesize,
    opcount,
    compiler: {
      name: boundedString(compiler.name, 'contract compiler name', 64),
      version: boundedString(compiler.version, 'contract compiler version', 64),
    },
  };
  if (contractType !== 'p2s') {
    result.address = boundedString(contract.address, 'contract address');
    result.tokenAddress = boundedString(contract.tokenAddress, 'contract token address');
  }
  if (contract.artifactFingerprint !== undefined) {
    result.artifactFingerprint = boundedString(contract.artifactFingerprint, 'artifact fingerprint');
  }
  return result;
}

export function parseInfo(value: unknown): AddonSDKInfo {
  const info = record(value, 'SDK metadata');
  if (typeof info.version !== 'string' || !info.version) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned invalid SDK metadata',
    });
  }
  const protocolVersion = nonNegativeIntegerValue(
    info.protocolVersion,
    'SDK protocol version'
  );
  const modules = Array.isArray(info.modules)
    ? info.modules.map((module) => {
        const parsed = stringValue(module, 'SDK module');
        if (!(parsed in ADDON_SDK_METHODS)) {
          throw new AddonSDKError({
            code: 'VALIDATION_FAILED',
            message: 'Wallet returned an unsupported SDK module',
          });
        }
        return parsed;
      })
    : (() => {
        throw new AddonSDKError({
          code: 'VALIDATION_FAILED',
          message: 'Wallet returned invalid SDK modules',
        });
      })();
  if (new Set(modules).size !== modules.length) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned duplicate SDK modules',
    });
  }
  const methodsValue = record(info.methods, 'SDK method metadata');
  const methods = Object.fromEntries(
    Object.entries(methodsValue).map(([module, methodList]) => [
      module,
      Array.isArray(methodList)
        ? methodList.map((method) => {
            const parsed = stringValue(method, 'SDK method');
            const known = ADDON_SDK_METHODS[
              module as keyof typeof ADDON_SDK_METHODS
            ] as readonly string[] | undefined;
            if (!known?.includes(parsed)) {
              throw new AddonSDKError({
                code: 'VALIDATION_FAILED',
                message: 'Wallet returned an unsupported SDK method',
              });
            }
            return parsed;
          })
        : (() => {
            throw new AddonSDKError({
              code: 'VALIDATION_FAILED',
              message: 'Wallet returned invalid SDK method metadata',
            });
          })(),
    ])
  );
  for (const methodList of Object.values(methods)) {
    if (new Set(methodList).size !== methodList.length) {
      throw new AddonSDKError({
        code: 'VALIDATION_FAILED',
        message: 'Wallet returned duplicate SDK methods',
      });
    }
  }
  const limits = record(info.limits, 'SDK limits');
  const cashTokenIntents = Array.isArray(info.cashTokenIntents)
    ? info.cashTokenIntents.map((intent) => {
        const parsed = stringValue(intent, 'CashToken intent');
        if (
          parsed !== 'transfer' &&
          parsed !== 'mint-fungible' &&
          parsed !== 'mint-nft' &&
          parsed !== 'mutate-nft' &&
          parsed !== 'burn'
        ) {
          throw new AddonSDKError({
            code: 'VALIDATION_FAILED',
            message: 'Wallet returned an unsupported CashToken intent',
          });
        }
        return parsed;
      })
    : [];
  const cashTokenLimits = record(info.cashTokenLimits, 'CashToken limits');
  const maxFungibleAmount = stringValue(
    cashTokenLimits.maxFungibleAmount,
    'maximum fungible CashToken amount'
  );
  if (!/^\d+$/.test(maxFungibleAmount)) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned an invalid maximum fungible CashToken amount',
    });
  }
  const capabilities = Array.isArray(info.capabilities)
    ? info.capabilities.map((capability) => {
        const parsed = stringValue(capability, 'SDK capability');
        if (!(ADDON_SDK_CAPABILITIES as readonly string[]).includes(parsed)) {
          throw new AddonSDKError({
            code: 'VALIDATION_FAILED',
            message: 'Wallet returned an unsupported SDK capability',
          });
        }
        return parsed;
      })
    : [];
  if (new Set(capabilities).size !== capabilities.length) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned duplicate SDK capabilities',
    });
  }
  return {
    version: info.version,
    protocolVersion,
    modules,
    methods,
    cashTokenIntents,
    cashTokenLimits: {
      maxFungibleAmount,
      maxNftCommitmentBytes: nonNegativeIntegerValue(
        cashTokenLimits.maxNftCommitmentBytes,
        'maximum NFT commitment size'
      ),
      tokenOutputMinimumSats: nonNegativeIntegerValue(
        cashTokenLimits.tokenOutputMinimumSats,
        'CashToken output minimum'
      ),
    },
    limits: {
      maxProposalInputs: numberValue(
        limits.maxProposalInputs,
        'maximum proposal inputs'
      ),
      maxProposalOutputs: numberValue(
        limits.maxProposalOutputs,
        'maximum proposal outputs'
      ),
      maxMessageLength: numberValue(
        limits.maxMessageLength,
        'maximum message length'
      ),
      maxIdempotencyKeyLength: numberValue(
        limits.maxIdempotencyKeyLength ?? 256,
        'maximum idempotency key length'
      ),
    },
    capabilities: capabilities as AddonSDKInfo['capabilities'],
  };
}

export function parseAuditTrail(value: unknown): AddonPolicyAuditEvent[] {
  if (!Array.isArray(value)) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned an invalid audit trail',
    });
  }
  return value.map((entry) => {
    const event = record(entry, 'audit event');
    return {
      at: stringValue(event.at, 'audit timestamp'),
      addonId: stringValue(event.addonId, 'audit add-on id'),
      capability: event.capability as AddonPolicyAuditEvent['capability'],
      action: event.action as AddonPolicyAuditEvent['action'],
    };
  });
}

export function parseContext(value: unknown): {
  walletId: number;
  network: string | null;
} {
  const context = record(value, 'wallet context');
  return {
    walletId: walletIdValue(context.walletId, 'wallet id'),
    network: networkValue(context.network, 'network'),
  };
}

export function parseAddresses(value: unknown) {
  if (!Array.isArray(value)) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned invalid addresses',
    });
  }
  return value.map((entry) => {
    const address = record(entry, 'address');
    return {
      address: stringValue(address.address, 'address'),
      tokenAddress: stringValue(address.tokenAddress, 'token address'),
    };
  });
}

export function parseUtxo(value: unknown): AddonUtxo {
  const utxo = record(value, 'UTXO');
  return {
    address: stringValue(utxo.address, 'UTXO address'),
    ...(utxo.tokenAddress === undefined
      ? {}
      : { tokenAddress: stringValue(utxo.tokenAddress, 'UTXO token address') }),
    height: numberValue(utxo.height, 'UTXO height'),
    tx_hash: stringValue(utxo.tx_hash, 'UTXO transaction id'),
    tx_pos: numberValue(utxo.tx_pos, 'UTXO output index'),
    value: numberValue(utxo.value, 'UTXO value'),
    ...(utxo.amount === undefined
      ? {}
      : { amount: numberValue(utxo.amount, 'UTXO amount') }),
    ...(utxo.prefix === undefined
      ? {}
      : { prefix: stringValue(utxo.prefix, 'UTXO prefix') }),
    ...(utxo.token === undefined
      ? {}
      : {
          token:
            utxo.token === null ? null : parseToken(utxo.token, 'UTXO token'),
        }),
  };
}

export function parseUtxos(value: unknown): AddonUtxo[] {
  if (!Array.isArray(value)) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned invalid UTXOs',
    });
  }
  return value.map(parseUtxo);
}

export function parseWalletUtxos(value: unknown) {
  const result = record(value, 'wallet UTXO result');
  return {
    allUtxos: parseUtxos(result.allUtxos),
    tokenUtxos: parseUtxos(result.tokenUtxos),
  };
}

export function parseProposal(value: unknown): AddonTransactionProposal {
  const proposal = record(value, 'transaction proposal');
  const inputs = parseUtxos(proposal.inputs);
  if (!Array.isArray(proposal.outputs)) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned invalid proposal outputs',
    });
  }
  const outputs = proposal.outputs.map(parseOutput);
  let contract: AddonTransactionProposal['contract'];
  if (proposal.contract !== undefined) {
    const contractRecord = record(proposal.contract, 'proposal contract');
    contract = {
      contractId: boundedString(contractRecord.contractId, 'proposal contract id'),
      functionName: boundedString(contractRecord.functionName, 'proposal contract function'),
      ...(contractRecord.artifactFingerprint === undefined
        ? {}
        : { artifactFingerprint: boundedString(contractRecord.artifactFingerprint, 'proposal artifact fingerprint') }),
    };
  }
  return {
    proposalId: boundedString(proposal.proposalId, 'proposal id'),
    commitmentHex: (() => {
      const commitment = stringValue(
        proposal.commitmentHex,
        'proposal commitment'
      ).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(commitment)) {
        throw new AddonSDKError({
          code: 'VALIDATION_FAILED',
          message: 'Wallet returned an invalid proposal commitment',
        });
      }
      return commitment;
    })(),
    walletId: walletIdValue(proposal.walletId, 'proposal wallet id'),
    network: networkValue(proposal.network, 'proposal network'),
    sessionId:
      proposal.sessionId === null
        ? null
        : boundedString(proposal.sessionId, 'proposal session id'),
    grantRevision: nullableRevisionValue(
      proposal.grantRevision,
      'proposal grant revision'
    ),
    authorityEpoch: nullableRevisionValue(
      proposal.authorityEpoch,
      'proposal authority epoch'
    ),
    createdAt: timestampString(proposal.createdAt, 'proposal creation time'),
    expiresAt: timestampString(proposal.expiresAt, 'proposal expiry'),
    inputs,
    outputs,
    ...(proposal.tokenIntent === undefined
      ? {}
      : { tokenIntent: parseTokenIntent(proposal.tokenIntent) }),
    ...(contract ? { contract } : {}),
    status:
      proposal.status === 'proposed'
        ? 'proposed'
        : (() => {
            throw new AddonSDKError({
              code: 'VALIDATION_FAILED',
              message: 'Wallet returned an invalid proposal status',
            });
          })(),
  };
}

export function parseOperation(value: unknown): AddonExecutionOperation {
  const operation = record(value, 'execution operation');
  const status = operation.status;
  if (
    status !== 'awaiting_approval' &&
    status !== 'signing' &&
    status !== 'submitting' &&
    status !== 'submission_unknown' &&
    status !== 'mempool' &&
    status !== 'confirmed' &&
    status !== 'rejected'
  ) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned invalid operation status',
    });
  }
  const mode = operation.mode;
  if (mode !== 'wallet-submit') {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned invalid operation mode',
    });
  }
  const createdAt = timestampString(
    operation.createdAt,
    'operation creation time'
  );
  const updatedAt = timestampString(
    operation.updatedAt,
    'operation update time'
  );
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned operation timestamps out of order',
    });
  }
  return {
    operationId: boundedString(operation.operationId, 'operation id'),
    ...(operation.txid === undefined
      ? {}
      : {
          txid: (() => {
            const txid = boundedString(
              operation.txid,
              'operation transaction id',
              64
            );
            if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
              throw new AddonSDKError({
                code: 'VALIDATION_FAILED',
                message: 'Wallet returned an invalid operation transaction id',
              });
            }
            return txid.toLowerCase();
          })(),
        }),
    status,
    createdAt,
    updatedAt,
    proposalId: boundedString(operation.proposalId, 'operation proposal id'),
    mode,
    sessionId:
      operation.sessionId === null
        ? null
        : boundedString(operation.sessionId, 'operation session id'),
    grantRevision:
      nullableRevisionValue(operation.grantRevision, 'operation grant revision'),
  };
}

function parseSignedRaw(value: unknown) {
  const raw = record(value, 'raw signature');
  return {
    ecdsa: boundedString(raw.ecdsa, 'ECDSA signature', 512),
    schnorr: boundedString(raw.schnorr, 'Schnorr signature', 512),
    der: boundedString(raw.der, 'DER signature', 512),
  };
}

function parseSignedDetails(value: unknown) {
  const details = record(value, 'signature details');
  const recoveryId = numberValue(details.recoveryId, 'signature recovery id');
  if (!Number.isInteger(recoveryId) || recoveryId < 0 || recoveryId > 3) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned an invalid signature recovery id',
    });
  }
  return {
    recoveryId,
    compressed:
      typeof details.compressed === 'boolean'
        ? details.compressed
        : (() => {
            throw new AddonSDKError({
              code: 'VALIDATION_FAILED',
              message: 'Wallet returned invalid signature compression state',
            });
          })(),
    messageHash: boundedString(details.messageHash, 'message hash', 256),
  };
}

export function parseSignedMessage(value: unknown): AddonSignedMessageResponse {
  const signed = record(value, 'signed message');
  if (
    signed.encoding !== undefined &&
    signed.encoding !== 'bch-signed-message'
  ) {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: 'Wallet returned an unsupported signature encoding',
    });
  }
  return safeClone({
    signature: boundedString(signed.signature, 'signature', 512),
    address: boundedString(signed.address, 'signing address'),
    encoding: 'bch-signed-message',
    ...(signed.raw === undefined || signed.raw === null
      ? {}
      : { raw: parseSignedRaw(signed.raw) }),
    ...(signed.details === undefined
      ? {}
      : { details: parseSignedDetails(signed.details) }),
  });
}

export function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AddonSDKError({
      code: 'VALIDATION_FAILED',
      message: `Wallet returned invalid ${label}`,
    });
  }
  return value;
}

export function parseString(value: unknown, label: string): string {
  return stringValue(value, label);
}
