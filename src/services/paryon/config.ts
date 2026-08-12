import type { ParyonDeploymentConfig, ParyonNetwork } from './types';

export const PARYON_MAINNET_V1_TOKEN_IDS = {
  paryonTokenId:
    '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
  poolTokenId:
    '7708645a7f30e97003573d9322202960a560a87527bef3666a30044a0dfdfa81',
  redeemerTokenId:
    '649b2d862f01a904addf9095ae64860a59071544ee4a3695f14cbbc75571f930',
  loanKeyFactoryTokenId:
    'f07165f2c3448ced3bf0b33f9048ceb7567a2c07adb60d8f11b301c42db97405',
  oracleMigrationKeyTokenId:
    '7776202e8f4eca51d5e634799c66c6a87076cc6efcc64c1322e7e880c71f6d30',
} as const;

export const PARYON_MAINNET_V1_GENESIS_TXIDS = {
  paryonTokenId:
    '9c938f53eb97e089c72c47e9e5cf5f68ad23fd5eb4cb579c5266f04bba4b4d62',
  poolTokenId:
    '6a9eb371b2f9379568dad9ed0d4757859f2aa1db33207b6b885135ed8db31c2f',
  redeemerTokenId:
    '693c322cf1f0012bd17e765ffb5fa46602c1a37af21f6a8a69447e0a511895ea',
  loanKeyFactoryTokenId:
    '9d432d0f13842ced1f37d03dc3d31faf628c24146292a4c69b09c1a6758a79ff',
  oracleMigrationKeyTokenId:
    '68180fe720cfd1240e8fc571843522a7fe151ddc6405d6c5d93f3543906051de',
} as const;

export const PARYON_MAINNET_V1_DEPLOYMENT: ParyonDeploymentConfig = {
  network: 'mainnet',
  oraclePublicKey:
    '02d09db08af1ff4e8453919cc866a4be427d7bfe18f2c05e5444c196fcf6fd2818',
  protocolFeeLockingBytecode:
    'aa207c7a248c794af2cdf1b1a66a2311347c45b177fcb3aad730a7823c9e32fc754087',
  startBlockHeight: 948406,
  periodLengthBlocks: 144,
  timeLockRedemption: 12,
  tokenIds: {
    paryonTokenId: PARYON_MAINNET_V1_TOKEN_IDS.paryonTokenId,
    poolTokenId: PARYON_MAINNET_V1_TOKEN_IDS.poolTokenId,
    redeemerTokenId: PARYON_MAINNET_V1_TOKEN_IDS.redeemerTokenId,
    loanKeyFactoryTokenId:
      PARYON_MAINNET_V1_TOKEN_IDS.loanKeyFactoryTokenId,
    oracleMigrationKeyTokenId:
      PARYON_MAINNET_V1_TOKEN_IDS.oracleMigrationKeyTokenId,
  },
};

const PARYON_CHIPNET_DEFAULT_DEPLOYMENT: ParyonDeploymentConfig = {
  network: 'chipnet',
  oraclePublicKey: '',
  protocolFeeLockingBytecode: '',
  startBlockHeight: 0,
  periodLengthBlocks: 144,
  timeLockRedemption: 0,
  tokenIds: {
    paryonTokenId: '',
    poolTokenId: '',
    redeemerTokenId: '',
    loanKeyFactoryTokenId: '',
    oracleMigrationKeyTokenId: '',
  },
};

function env(key: string): string | undefined {
  return (
    import.meta.env?.[key] ||
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env?.[key]
  );
}

function readNetworkValue(
  network: ParyonNetwork,
  key: string,
  fallback: string
): string {
  return (
    env(`VITE_PARYON_${network.toUpperCase()}_${key}`) ||
    env(`PARYON_${network.toUpperCase()}_${key}`) ||
    fallback
  ).trim();
}

function readNetworkInt(
  network: ParyonNetwork,
  key: string,
  fallback: number
): number {
  const raw = readNetworkValue(network, key, String(fallback));
  if (!raw.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readTokenIds(
  network: ParyonNetwork,
  defaults: ParyonDeploymentConfig['tokenIds']
): ParyonDeploymentConfig['tokenIds'] {
  return {
    paryonTokenId: readNetworkValue(
      network,
      'PARYON_TOKEN_ID',
      defaults.paryonTokenId
    ),
    poolTokenId: readNetworkValue(
      network,
      'POOL_TOKEN_ID',
      defaults.poolTokenId
    ),
    redeemerTokenId: readNetworkValue(
      network,
      'REDEEMER_TOKEN_ID',
      defaults.redeemerTokenId
    ),
    loanKeyFactoryTokenId: readNetworkValue(
      network,
      'LOAN_KEY_FACTORY_TOKEN_ID',
      defaults.loanKeyFactoryTokenId
    ),
    oracleMigrationKeyTokenId: readNetworkValue(
      network,
      'ORACLE_MIGRATION_KEY_TOKEN_ID',
      defaults.oracleMigrationKeyTokenId
    ),
  };
}

function readConfig(network: ParyonNetwork): ParyonDeploymentConfig {
  const defaults =
    network === 'mainnet'
      ? PARYON_MAINNET_V1_DEPLOYMENT
      : PARYON_CHIPNET_DEFAULT_DEPLOYMENT;

  return {
    network,
    oraclePublicKey: readNetworkValue(
      network,
      'ORACLE_PUBLIC_KEY',
      defaults.oraclePublicKey
    ),
    protocolFeeLockingBytecode: readNetworkValue(
      network,
      'PROTOCOL_FEE_LOCKING_BYTECODE',
      defaults.protocolFeeLockingBytecode
    ),
    startBlockHeight: readNetworkInt(
      network,
      'START_BLOCK_HEIGHT',
      defaults.startBlockHeight
    ),
    periodLengthBlocks: readNetworkInt(
      network,
      'PERIOD_LENGTH_BLOCKS',
      defaults.periodLengthBlocks
    ),
    timeLockRedemption: readNetworkInt(
      network,
      'TIME_LOCK_REDEMPTION',
      defaults.timeLockRedemption
    ),
    tokenIds: readTokenIds(network, defaults.tokenIds),
  };
}

function isHexString(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed);
}

function isTokenId(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value.trim());
}

function isCompressedPublicKey(value: string): boolean {
  return /^(02|03)[0-9a-fA-F]{64}$/.test(value.trim());
}

export function getParyonDeploymentConfig(
  network: string | null | undefined
): ParyonDeploymentConfig {
  const normalized: ParyonNetwork =
    network === 'chipnet' ? 'chipnet' : 'mainnet';
  return readConfig(normalized);
}

export function validateParyonDeploymentConfig(
  config: ParyonDeploymentConfig
): string[] {
  const errors: string[] = [];

  if (!config.oraclePublicKey.trim()) {
    errors.push('oraclePublicKey is required');
  } else if (!isCompressedPublicKey(config.oraclePublicKey)) {
    errors.push('oraclePublicKey must be a compressed public key hex string');
  }

  if (!config.protocolFeeLockingBytecode.trim()) {
    errors.push('protocolFeeLockingBytecode is required');
  } else if (!isHexString(config.protocolFeeLockingBytecode)) {
    errors.push('protocolFeeLockingBytecode must be hex');
  }

  if (!Number.isInteger(config.startBlockHeight) || config.startBlockHeight < 0) {
    errors.push('startBlockHeight must be a non-negative integer');
  }

  if (
    !Number.isInteger(config.periodLengthBlocks) ||
    config.periodLengthBlocks <= 0
  ) {
    errors.push('periodLengthBlocks must be a positive integer');
  }

  if (
    !Number.isInteger(config.timeLockRedemption) ||
    config.timeLockRedemption <= 0
  ) {
    errors.push('timeLockRedemption must be a positive integer');
  } else if (config.timeLockRedemption > 65_535) {
    errors.push('timeLockRedemption must be at most 65535');
  }

  for (const [key, value] of Object.entries(config.tokenIds)) {
    if (!value.trim()) {
      errors.push(`tokenIds.${key} is required`);
      continue;
    }
    if (!isTokenId(value)) {
      errors.push(`tokenIds.${key} must be a 64-character hex token id`);
    }
  }

  return errors;
}
