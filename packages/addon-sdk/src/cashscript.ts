import { AddonSDKError } from './transport.js';
import type {
  AddonCashScriptAbiFunction,
  AddonCashScriptAbiInput,
  AddonCashScriptArtifact,
  AddonCashScriptValue,
  AddonCashScriptFunctionArgument,
  AddonContractType,
} from './types.js';

const MAX_ARTIFACT_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_ABI_ENTRIES = 128;
const TYPE = /^(bool|int|string|bytes|byte|bytes\d+|pubkey|sig|datasig)$/;

function fail(message: string): never {
  throw new AddonSDKError({ code: 'INVALID_REQUEST', message });
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(`${label} must contain between 1 and ${max} characters`);
  }
  return value;
}

function abiInput(value: unknown, label: string): AddonCashScriptAbiInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an ABI input`);
  }
  const input = value as Record<string, unknown>;
  const name = boundedString(input.name, `${label} name`, 128);
  const type = boundedString(input.type, `${label} type`, 64);
  if (!TYPE.test(type)) fail(`${label} has an unsupported CashScript type`);
  return { name, type };
}

function abiFunction(value: unknown, index: number): AddonCashScriptAbiFunction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`artifact.abi[${index}] must be an ABI function`);
  }
  const fn = value as Record<string, unknown>;
  const name = boundedString(fn.name, `artifact.abi[${index}] name`, 128);
  if (!Array.isArray(fn.inputs) || fn.inputs.length > MAX_ABI_ENTRIES) {
    fail(`artifact.abi[${index}].inputs is invalid`);
  }
  return {
    name,
    inputs: fn.inputs.map((input, inputIndex) =>
      abiInput(input, `artifact.abi[${index}].inputs[${inputIndex}]`)
    ),
  };
}

export function validateCashScriptArtifact(value: unknown): AddonCashScriptArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CashScript artifact must be an object');
  }
  const artifact = value as Record<string, unknown>;
  const contractName = boundedString(artifact.contractName, 'artifact.contractName', 128);
  const bytecode = boundedString(artifact.bytecode, 'artifact.bytecode', MAX_ARTIFACT_BYTES);
  if (!artifact.compiler || typeof artifact.compiler !== 'object') fail('artifact.compiler is required');
  const compiler = artifact.compiler as Record<string, unknown>;
  const compilerName = boundedString(compiler.name, 'artifact.compiler.name', 64);
  const compilerVersion = boundedString(compiler.version, 'artifact.compiler.version', 64);
  if (!Array.isArray(artifact.constructorInputs) || artifact.constructorInputs.length > MAX_ABI_ENTRIES) {
    fail('artifact.constructorInputs is invalid');
  }
  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0 || artifact.abi.length > MAX_ABI_ENTRIES) {
    fail('artifact.abi is invalid');
  }
  const constructorInputs = artifact.constructorInputs.map((input, index) =>
    abiInput(input, `artifact.constructorInputs[${index}]`)
  );
  const abi = artifact.abi.map((fn, index) => abiFunction(fn, index));
  if (new Set(abi.map((fn) => fn.name)).size !== abi.length) fail('artifact.abi contains duplicate function names');
  if (artifact.source !== undefined) boundedString(artifact.source, 'artifact.source', MAX_SOURCE_BYTES);
  if (artifact.fingerprint !== undefined) boundedString(artifact.fingerprint, 'artifact.fingerprint', 256);
  return {
    contractName,
    constructorInputs,
    abi,
    bytecode,
    ...(artifact.source === undefined ? {} : { source: artifact.source as string }),
    compiler: { name: compilerName, version: compilerVersion },
    ...(artifact.updatedAt === undefined ? {} : { updatedAt: String(artifact.updatedAt) }),
    ...(artifact.fingerprint === undefined ? {} : { fingerprint: artifact.fingerprint as string }),
  };
}

export function validateContractType(value: unknown): AddonContractType {
  if (value !== 'p2sh20' && value !== 'p2sh32' && value !== 'p2s') fail('Unsupported CashScript contract type');
  return value;
}

export function validateCashScriptValues(value: unknown, label: string): AddonCashScriptValue[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${label}[${index}] is invalid`);
    const record = item as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== 'string' || !TYPE.test(type)) fail(`${label}[${index}] has an unsupported type`);
    if (typeof record.value !== 'string' && typeof record.value !== 'boolean') fail(`${label}[${index}].value is invalid`);
    if (type !== 'bool' && typeof record.value !== 'string') fail(`${label}[${index}].value must be a string`);
    const hexValue = typeof record.value === 'string' ? record.value.replace(/^0x/, '') : '';
    if (
      typeof record.value === 'string' &&
      (type === 'bytes' || type === 'byte' || type.startsWith('bytes') ||
        type === 'pubkey' || type === 'sig' || type === 'datasig') &&
      (!/^[0-9a-fA-F]*$/.test(hexValue) || hexValue.length % 2 === 1)
    ) {
      fail(`${label}[${index}].value must be hexadecimal`);
    }
    if (type === 'int' && typeof record.value === 'string' && !/^-?(0|[1-9]\d*)$/.test(record.value)) {
      fail(`${label}[${index}].value must be a canonical decimal integer`);
    }
    if (typeof record.value === 'string' && type === 'byte' && hexValue.length !== 2) {
      fail(`${label}[${index}].value must contain exactly one byte`);
    }
    const bounded = type.match(/^bytes(\d+)$/);
    if (typeof record.value === 'string' && bounded && hexValue.length !== Number(bounded[1]) * 2) {
      fail(`${label}[${index}].value has the wrong byte length`);
    }
    return { type: type as AddonCashScriptValue['type'], value: record.value as never };
  });
}

export function validateCashScriptFunctionArguments(
  value: unknown,
  label: string,
): AddonCashScriptFunctionArgument[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${label}[${index}] is invalid`);
    const record = item as Record<string, unknown>;
    if ((record.type === 'sig' || record.type === 'datasig') && record.signer !== undefined) {
      const signer = record.signer;
      if (!signer || typeof signer !== 'object' || Array.isArray(signer)) fail(`${label}[${index}].signer is invalid`);
      const signerRecord = signer as Record<string, unknown>;
      if (record.type === 'sig' && signerRecord.purpose !== 'wallet-spend') fail(`${label}[${index}] has an invalid signer purpose`);
      if (record.type === 'datasig' && signerRecord.purpose !== 'wallet-spend' && signerRecord.purpose !== 'external') fail(`${label}[${index}] has an invalid signer purpose`);
      const address = boundedString(signerRecord.address, `${label}[${index}] signer address`, 256);
      if (record.type === 'sig') {
        return { type: 'sig', signer: { address, purpose: 'wallet-spend' } };
      }
      const value = boundedString(record.value, `${label}[${index}].value`, 2_000_000);
      if (!/^[0-9a-fA-F]*$/.test(value.replace(/^0x/, '')) || value.replace(/^0x/, '').length % 2 === 1) {
        fail(`${label}[${index}].value must be hexadecimal`);
      }
      return { type: 'datasig', value, signer: { address, purpose: signerRecord.purpose as 'wallet-spend' | 'external' } };
    }
    const values = validateCashScriptValues([item], label);
    return values[0] as AddonCashScriptFunctionArgument;
  });
}

/** Validate a call against the artifact ABI before it crosses the host boundary. */
export function validateCashScriptFunctionCall(
  artifact: AddonCashScriptArtifact,
  functionName: string,
  args: AddonCashScriptFunctionArgument[],
): AddonCashScriptFunctionArgument[] {
  const fn = artifact.abi.find((candidate) => candidate.name === functionName);
  if (!fn) fail(`CashScript function '${functionName}' is not declared by the artifact ABI`);
  if (fn.inputs.length !== args.length) {
    fail(`CashScript function '${functionName}' expects ${fn.inputs.length} arguments`);
  }
  args.forEach((arg, index) => {
    const expected = fn.inputs[index].type;
    if (arg.type !== expected) {
      fail(`CashScript function '${functionName}' argument ${index} must have type ${expected}`);
    }
  });
  return args;
}

export function validateCashScriptConstructorCall(
  artifact: AddonCashScriptArtifact,
  args: AddonCashScriptValue[],
): AddonCashScriptValue[] {
  if (artifact.constructorInputs.length !== args.length) {
    fail(`CashScript constructor expects ${artifact.constructorInputs.length} arguments`);
  }
  args.forEach((arg, index) => {
    if (artifact.constructorInputs[index].type !== arg.type) {
      fail(`CashScript constructor argument ${index} must have type ${artifact.constructorInputs[index].type}`);
    }
  });
  return args;
}
