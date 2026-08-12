// Test-only chipnet consensus validator.
// Keep this out of src so the mobile APK bundle stays Fulcrum-only.
/* eslint-env node */
import { execFile } from 'node:child_process';

import {
  validateQuantumrootAuthorizedSpendAgainstFulcrum,
  type QuantumrootAuthorizedSpendFulcrumValidationRequest,
} from '../src/services/QuantumrootFulcrumValidationService';

type QuantumrootNodeConsensusValidatorOptions = {
  bitcoinCliBinary?: string;
  bitcoinCliConfigPath?: string;
  containerName?: string;
  sshTarget?: string;
  timeoutMs?: number;
};

export type QuantumrootNodeConsensusResult = {
  allowed: boolean;
  available: boolean;
  rawResponse: unknown;
  reason: string | null;
};

export type QuantumrootChipnetConsensusValidationOptions = {
  nodeValidator?: (rawTransaction: string) => Promise<QuantumrootNodeConsensusResult>;
  requireNodeConsensus?: boolean;
};

const DEFAULT_SSH_TARGET = 'lightswarm@192.168.31.218';
const DEFAULT_CONTAINER_NAME = 'bch-chipnet';
const DEFAULT_BITCOIN_CLI = 'bitcoin-cli';
const DEFAULT_BITCOIN_CLI_CONFIG = '/data/bitcoin.conf';

function readEnv(name: string): string | undefined {
  const metaEnv =
    typeof import.meta !== 'undefined'
      ? ((import.meta as ImportMeta & { env?: Record<string, unknown> }).env ??
        {})
      : {};
  const nodeEnv =
    typeof process !== 'undefined'
      ? ((process as { env?: Record<string, unknown> }).env ?? {})
      : {};

  const viteValue = metaEnv[name];
  const nodeValue = nodeEnv[name];
  if (typeof viteValue === 'string') return viteValue;
  if (typeof nodeValue === 'string') return nodeValue;
  return undefined;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runSshCommand(
  sshTarget: string,
  remoteCommand: string,
  timeoutMs: number
): Promise<{ stderr: string; stdout: string }> {
  return await new Promise((resolve, reject) => {
    execFile(
      'ssh',
      [sshTarget, remoteCommand],
      {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

export function createQuantumrootChipnetNodeValidator(
  options: QuantumrootNodeConsensusValidatorOptions = {}
) {
  const sshTarget =
    options.sshTarget ||
    readEnv('VITE_QUANTUMROOT_BCHN_SSH_TARGET') ||
    DEFAULT_SSH_TARGET;
  const containerName =
    options.containerName ||
    readEnv('VITE_QUANTUMROOT_BCHN_CONTAINER_NAME') ||
    DEFAULT_CONTAINER_NAME;
  const bitcoinCliBinary =
    options.bitcoinCliBinary ||
    readEnv('VITE_QUANTUMROOT_BCHN_BITCOIN_CLI') ||
    DEFAULT_BITCOIN_CLI;
  const bitcoinCliConfigPath =
    options.bitcoinCliConfigPath ||
    readEnv('VITE_QUANTUMROOT_BCHN_BITCOIN_CLI_CONF') ||
    DEFAULT_BITCOIN_CLI_CONFIG;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return async function validateOnNode(
    rawTransaction: string
  ): Promise<QuantumrootNodeConsensusResult> {
    const rawArrayArg = JSON.stringify([rawTransaction]);
    const remoteCommand = [
      'docker',
      'exec',
      shellEscape(containerName),
      shellEscape(bitcoinCliBinary),
      `-conf=${shellEscape(bitcoinCliConfigPath)}`,
      'testmempoolaccept',
      shellEscape(rawArrayArg),
    ].join(' ');

    try {
      const { stdout } = await runSshCommand(sshTarget, remoteCommand, timeoutMs);
      const parsed = JSON.parse(stdout) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.length === 0 ||
        typeof parsed[0] !== 'object' ||
        parsed[0] === null
      ) {
        return {
          allowed: false,
          available: true,
          rawResponse: parsed,
          reason: 'Unexpected testmempoolaccept response shape.',
        };
      }

      const first = parsed[0] as {
        allowed?: unknown;
        'reject-reason'?: unknown;
      };
      return {
        allowed: first.allowed === true,
        available: true,
        rawResponse: parsed,
        reason:
          typeof first['reject-reason'] === 'string'
            ? first['reject-reason']
            : first.allowed === true
              ? null
              : 'Transaction rejected by chipnet node.',
      };
    } catch (error) {
      const stderr = error instanceof Error ? (error as Error & { stderr?: unknown }).stderr : undefined;
      const combinedMessage = [
        error instanceof Error ? error.message : String(error),
        typeof stderr === 'string' ? stderr : '',
      ]
        .filter(Boolean)
        .join('\n')
        .trim();
      if (
        combinedMessage.includes('error code:') ||
        combinedMessage.includes('error message:') ||
        combinedMessage.includes('TX decode failed')
      ) {
        return {
          allowed: false,
          available: true,
          rawResponse: null,
          reason: combinedMessage,
        };
      }
      return {
        allowed: false,
        available: false,
        rawResponse: null,
        reason: combinedMessage,
      };
    }
  };
}

export async function validateQuantumrootAuthorizedSpendAgainstChipnet(
  request: QuantumrootAuthorizedSpendFulcrumValidationRequest,
  options: QuantumrootChipnetConsensusValidationOptions = {}
) {
  const fulcrumValidation = await validateQuantumrootAuthorizedSpendAgainstFulcrum(
    request
  );
  const nodeValidator =
    options.nodeValidator ?? createQuantumrootChipnetNodeValidator();
  const nodeConsensus = await nodeValidator(request.rawTransaction);

  if (!nodeConsensus.available && options.requireNodeConsensus) {
    throw new Error(
      `Quantumroot chipnet consensus validation could not reach the node: ${nodeConsensus.reason ?? 'unknown error'}`
    );
  }

  if (!nodeConsensus.available && !options.requireNodeConsensus) {
    return {
      ...fulcrumValidation,
      consensusSource: 'fulcrum' as const,
      nodeConsensus,
    };
  }

  if (!nodeConsensus.allowed) {
    if (options.requireNodeConsensus) {
      throw new Error(
        `Quantumroot chipnet node rejected the spend: ${nodeConsensus.reason ?? 'unknown reason'}`
      );
    }
    return {
      ...fulcrumValidation,
      consensusSource: 'bchn' as const,
      nodeConsensus,
    };
  }

  return {
    ...fulcrumValidation,
    consensusSource: 'bchn' as const,
    nodeConsensus,
  };
}
