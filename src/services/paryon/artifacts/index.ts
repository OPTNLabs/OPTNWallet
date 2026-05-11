import artifactBorrowing from './Borrowing';
import artifactPriceContract from './PriceContract';
import artifactLoan from './Loan';
import artifactLoanSidecar from './LoanSidecar';
import artifactLoanKeyFactory from './LoanKeyFactory';
import artifactLoanKeyOriginEnforcer from './LoanKeyOriginEnforcer';
import artifactLoanKeyOriginProof from './LoanKeyOriginProof';
import artifactRedemption from './Redemption';
import artifactRedemptionSidecar from './RedemptionSidecar';
import artifactRedeemer from './Redeemer';
import artifactStabilityPool from './StabilityPool';
import artifactStabilityPoolSidecar from './StabilityPoolSidecar';
import artifactCollector from './Collector';
import artifactPayout from './Payout';
import artifactAddLiquidity from './AddLiquidity';
import artifactLiquidateLoan from './LiquidateLoan';
import artifactNewPeriodPool from './NewPeriodPool';
import artifactWithdrawFromPool from './WithdrawFromPool';
import artifactLiquidate from './liquidate';
import artifactManage from './manage';
import artifactRedeem from './redeem';
import artifactStartRedemption from './startRedemption';
import artifactSwapInRedemption from './swapInRedemption';
import artifactSwapOutRedemption from './swapOutRedemption';
import artifactPayInterest from './payInterest';
import artifactChangeInterest from './changeInterest';

import type { ParyonContractBundleName, ParyonContractDescriptor } from '../types';

export const PARYON_ARTIFACTS: Record<
  ParyonContractBundleName,
  ParyonContractDescriptor
> = {
  Borrowing: { name: 'Borrowing', artifact: artifactBorrowing },
  Loan: { name: 'Loan', artifact: artifactLoan },
  LoanSidecar: { name: 'LoanSidecar', artifact: artifactLoanSidecar },
  PriceContract: { name: 'PriceContract', artifact: artifactPriceContract },
  LoanKeyFactory: { name: 'LoanKeyFactory', artifact: artifactLoanKeyFactory },
  LoanKeyOriginEnforcer: {
    name: 'LoanKeyOriginEnforcer',
    artifact: artifactLoanKeyOriginEnforcer,
  },
  LoanKeyOriginProof: {
    name: 'LoanKeyOriginProof',
    artifact: artifactLoanKeyOriginProof,
  },
  Redemption: { name: 'Redemption', artifact: artifactRedemption },
  RedemptionSidecar: {
    name: 'RedemptionSidecar',
    artifact: artifactRedemptionSidecar,
  },
  Redeemer: { name: 'Redeemer', artifact: artifactRedeemer },
  StabilityPool: { name: 'StabilityPool', artifact: artifactStabilityPool },
  StabilityPoolSidecar: {
    name: 'StabilityPoolSidecar',
    artifact: artifactStabilityPoolSidecar,
  },
  Collector: { name: 'Collector', artifact: artifactCollector },
  Payout: { name: 'Payout', artifact: artifactPayout },
  AddLiquidity: { name: 'AddLiquidity', artifact: artifactAddLiquidity },
  LiquidateLoan: { name: 'LiquidateLoan', artifact: artifactLiquidateLoan },
  NewPeriodPool: { name: 'NewPeriodPool', artifact: artifactNewPeriodPool },
  WithdrawFromPool: { name: 'WithdrawFromPool', artifact: artifactWithdrawFromPool },
  liquidate: { name: 'liquidate', artifact: artifactLiquidate },
  manage: { name: 'manage', artifact: artifactManage },
  redeem: { name: 'redeem', artifact: artifactRedeem },
  startRedemption: {
    name: 'startRedemption',
    artifact: artifactStartRedemption,
  },
  swapInRedemption: {
    name: 'swapInRedemption',
    artifact: artifactSwapInRedemption,
  },
  swapOutRedemption: {
    name: 'swapOutRedemption',
    artifact: artifactSwapOutRedemption,
  },
  payInterest: { name: 'payInterest', artifact: artifactPayInterest },
  changeInterest: { name: 'changeInterest', artifact: artifactChangeInterest },
};

export function listParyonArtifactNames(): ParyonContractBundleName[] {
  return Object.keys(PARYON_ARTIFACTS) as ParyonContractBundleName[];
}

