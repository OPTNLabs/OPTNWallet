import type { UTXO } from '../../types/types';

export const CAULDRON_V0_VERSION = '0' as const;
export const CAULDRON_NATIVE_BCH = 'bch' as const;

export type CauldronTokenId = string | typeof CAULDRON_NATIVE_BCH;

export type CauldronActivePoolRecord = {
  owner_pkh: string;
  owner_p2pkh_addr: string;
  token_id: string;
  sats: number | string | bigint;
  tokens: number | string | bigint;
  txid: string;
  tx_pos: number;
  pool_id: string;
};

export type CauldronRostrumPoolRecord = {
  is_withdrawn?: boolean;
  new_utxo_hash?: string;
  new_utxo_n?: number;
  new_utxo_txid?: string;
  pkh?: string;
  sats?: number | string | bigint;
  spent_utxo_hash?: string;
  token_amount?: number | string | bigint;
  token_id?: string;
};

export type CauldronTokenListItemCached = {
  token_id: string;
  trade_volume: number;
  tvl_sats: number;
  tvl_tokens: number;
  trade_count: number;
  score: number;
  score_rank: number;
  price_now: number;
  price_24h?: number | null;
  price_7d?: number | null;
  change_24h_bp?: number | null;
  change_7d_bp?: number | null;
  display_name?: string | null;
  display_symbol?: string | null;
  price_now_usd: number;
  price_24h_usd?: number | null;
  price_7d_usd?: number | null;
  change_24h_usd_bp?: number | null;
  change_7d_usd_bp?: number | null;
  apy_30d_bp?: number | null;
  bcmr?: Record<string, unknown> | null;
  bcmr_well_known?: Array<Record<string, unknown>>;
};

export type CauldronPoolParameters = {
  withdrawPublicKeyHash: Uint8Array;
};

export type CauldronPoolOutput = {
  amountSatoshis: bigint;
  tokenCategory: string;
  tokenAmount: bigint;
  lockingBytecode: Uint8Array;
};

export type CauldronPool = {
  version: typeof CAULDRON_V0_VERSION;
  parameters: CauldronPoolParameters;
  txHash: string;
  outputIndex: number;
  ownerPublicKeyHash?: string | null;
  ownerAddress?: string | null;
  poolId?: string | null;
  output: CauldronPoolOutput;
};

export type CauldronPoolPair = {
  reserveA: bigint;
  reserveB: bigint;
  minReserveA: bigint;
  minReserveB: bigint;
  feePaidInA: boolean;
};

export type CauldronTrade = {
  demandTokenId: CauldronTokenId;
  supplyTokenId: CauldronTokenId;
  demand: bigint;
  supply: bigint;
  tradeFee: bigint;
};

export type CauldronPoolTrade = CauldronTrade & {
  pool: CauldronPool;
};

export type CauldronTradeSummary = {
  demand: bigint;
  supply: bigint;
  tradeFee: bigint;
  rateNumerator: bigint;
  rateDenominator: bigint;
};

export type CauldronDirectionLiquidity = {
  executablePoolCount: number;
  maxSupply: bigint;
  maxDemand: bigint;
};

export type CauldronMarketLiquidity = {
  bchToToken: CauldronDirectionLiquidity;
  tokenToBch: CauldronDirectionLiquidity;
};

export type CauldronUnlockingKind = 'trade' | 'withdraw';

export type ParsedCauldronUnlockingBytecode = {
  parameters: CauldronPoolParameters;
  kind: CauldronUnlockingKind;
};

export type CauldronPoolUtxoCandidate = Pick<
  UTXO,
  'tx_hash' | 'tx_pos' | 'token'
> & {
  value?: number | string | bigint;
  amount?: number | string | bigint;
  lockingBytecode: Uint8Array;
};

export type CauldronWalletPoolPosition = {
  pool: CauldronPool;
  ownerAddress: string | null;
  historyPoolId?: string | null;
  matchingNftUtxos: UTXO[];
  hasMatchingTokenNft: boolean;
  detectionSource: 'owner_pkh' | 'pool_nft_commitment' | 'token_nft_hint';
};

export type CauldronPoolHistoryEntry = {
  sats: number;
  tokens: number;
  timestamp: number;
  txid: string;
};

export type CauldronPoolHistoryResponse = {
  history: CauldronPoolHistoryEntry[];
  token_id: string;
  owner_pkh: string;
};

export type CauldronAggregatedApyResponse = {
  apy?: string | number | null;
  pools?: number | null;
};
