import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PARYON_MAINNET_V1_DEPLOYMENT,
  getParyonDeploymentConfig,
  validateParyonDeploymentConfig,
} from '../config';
import {
  isVerifiedParyonMainnetDeployment,
  resolveParyonWorkspaceSnapshot,
} from '../ParyonService';

describe('ParyonService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads the verified live mainnet deployment and validates cleanly', () => {
    const config = getParyonDeploymentConfig('mainnet');

    expect(config).toEqual(PARYON_MAINNET_V1_DEPLOYMENT);
    expect(validateParyonDeploymentConfig(config)).toEqual([]);
    expect(isVerifiedParyonMainnetDeployment(config)).toBe(true);
  });

  it('uses network-specific env overrides and ignores generic Paryon env vars', () => {
    vi.stubEnv('PARYON_MAINNET_ORACLE_PUBLIC_KEY', '03'.repeat(33));
    vi.stubEnv(
      'VITE_PARYON_MAINNET_ORACLE_PUBLIC_KEY',
      '02'.repeat(33)
    );
    vi.stubEnv(
      'VITE_PARYON_MAINNET_PROTOCOL_FEE_LOCKING_BYTECODE',
      'ab'.repeat(40)
    );
    vi.stubEnv('VITE_PARYON_MAINNET_START_BLOCK_HEIGHT', '12345');
    vi.stubEnv('VITE_PARYON_MAINNET_PERIOD_LENGTH_BLOCKS', '144');
    vi.stubEnv('VITE_PARYON_MAINNET_TIME_LOCK_REDEMPTION', '12');
    vi.stubEnv('VITE_PARYON_MAINNET_PARYON_TOKEN_ID', '11'.repeat(32));
    vi.stubEnv('VITE_PARYON_MAINNET_POOL_TOKEN_ID', '22'.repeat(32));
    vi.stubEnv('VITE_PARYON_MAINNET_REDEEMER_TOKEN_ID', '33'.repeat(32));
    vi.stubEnv(
      'VITE_PARYON_MAINNET_LOAN_KEY_FACTORY_TOKEN_ID',
      '44'.repeat(32)
    );
    vi.stubEnv(
      'VITE_PARYON_MAINNET_ORACLE_MIGRATION_KEY_TOKEN_ID',
      '55'.repeat(32)
    );

    const config = getParyonDeploymentConfig('mainnet');

    expect(config.oraclePublicKey).toBe('02'.repeat(33));
    expect(config.protocolFeeLockingBytecode).toBe('ab'.repeat(40));
    expect(config.startBlockHeight).toBe(12345);
    expect(config.periodLengthBlocks).toBe(144);
    expect(config.timeLockRedemption).toBe(12);
    expect(config.tokenIds.paryonTokenId).toBe('11'.repeat(32));
    expect(config.tokenIds.poolTokenId).toBe('22'.repeat(32));
    expect(validateParyonDeploymentConfig(config)).toEqual([]);
  });

  it('fails closed for chipnet until deployment values are provided', () => {
    const config = getParyonDeploymentConfig('chipnet');

    expect(config.network).toBe('chipnet');
    expect(validateParyonDeploymentConfig(config)).toEqual(
      expect.arrayContaining([
        'oraclePublicKey is required',
        'protocolFeeLockingBytecode is required',
        'timeLockRedemption must be a positive integer',
        'tokenIds.paryonTokenId is required',
        'tokenIds.poolTokenId is required',
        'tokenIds.redeemerTokenId is required',
        'tokenIds.loanKeyFactoryTokenId is required',
        'tokenIds.oracleMigrationKeyTokenId is required',
      ])
    );

    const snapshot = resolveParyonWorkspaceSnapshot('chipnet');
    expect(snapshot.readiness).toBe('missing-config');
    expect(snapshot.verifiedMainnetV1).toBe(false);
    expect(snapshot.primaryAction.label).toBe('Set deployment config');
    expect(snapshot.verificationLabel).toBe('Needs deployment config');
  });

  it('resolves the live mainnet contract graph and core constructor wiring', () => {
    const snapshot = resolveParyonWorkspaceSnapshot('mainnet');

    expect(snapshot.readiness).toBe('ready');
    expect(snapshot.verifiedMainnetV1).toBe(true);
    expect(snapshot.deploymentProfile).toBe('mainnet-v1');
    expect(snapshot.contractCount).toBe(26);
    expect(snapshot.validationErrors).toEqual([]);
    expect(snapshot.verificationLabel).toBe('Verified live mainnet-v1');
    expect(snapshot.primaryAction).toEqual({
      label: 'Open stablecoin actions',
      targetSection: 'actions',
    });

    expect(snapshot.contractsByName.Collector.resolved).toBe(true);
    expect(snapshot.contractsByName.Borrowing.resolved).toBe(true);
    expect(snapshot.contractsByName.NewPeriodPool.resolved).toBe(true);
    expect(snapshot.contractsByName.Redeemer.resolved).toBe(true);
    expect(snapshot.contractsByName.PriceContract.resolved).toBe(true);

    expect(snapshot.contractsByName.Collector.constructorInputs[0]).toBe(
      PARYON_MAINNET_V1_DEPLOYMENT.tokenIds.paryonTokenId
    );
    expect(snapshot.contractsByName.Collector.constructorInputs[1]).toBe(
      PARYON_MAINNET_V1_DEPLOYMENT.protocolFeeLockingBytecode
    );

    expect(snapshot.contractsByName.Borrowing.constructorInputs[0]).toBe(
      snapshot.contractsByName.Loan.lockingBytecodeHex
    );
    expect(snapshot.contractsByName.Borrowing.constructorInputs[1]).toBe(
      snapshot.contractsByName.LoanSidecar.lockingBytecodeHex
    );
    expect(snapshot.contractsByName.Borrowing.constructorInputs[2]).toBe(
      PARYON_MAINNET_V1_DEPLOYMENT.protocolFeeLockingBytecode
    );
    expect(snapshot.contractsByName.Borrowing.constructorInputs[3]).toBe(
      snapshot.contractsByName.LoanKeyOriginEnforcer.lockingBytecodeHex
    );

    expect(snapshot.contractsByName.NewPeriodPool.constructorInputs[0]).toBe(
      snapshot.contractsByName.Payout.lockingBytecodeHex
    );
    expect(snapshot.contractsByName.NewPeriodPool.constructorInputs[1]).toBe(
      snapshot.contractsByName.Collector.lockingBytecodeHex
    );

    expect(snapshot.contractsByName.Redeemer.constructorInputs[0]).toBe(
      PARYON_MAINNET_V1_DEPLOYMENT.tokenIds.paryonTokenId
    );
    expect(snapshot.contractsByName.Redeemer.constructorInputs[1]).toBe(
      snapshot.contractsByName.Redemption.lockingBytecodeHex
    );
    expect(snapshot.contractsByName.Redeemer.constructorInputs[2]).toBe(
      snapshot.contractsByName.RedemptionSidecar.lockingBytecodeHex
    );

    expect(snapshot.contractsByName.PriceContract.constructorInputs[0]).toBe(
      PARYON_MAINNET_V1_DEPLOYMENT.oraclePublicKey
    );
    expect(snapshot.contractsByName.PriceContract.constructorInputs[1]).toBe(
      PARYON_MAINNET_V1_DEPLOYMENT.tokenIds.oracleMigrationKeyTokenId
    );
  });
});
