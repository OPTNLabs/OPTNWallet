import type {
  CampaignRecord,
  ChainCampaign,
  FundMeChainOutput,
  ShortCampaignPayload,
} from './types';
import { DEFAULT_BANNER } from './types';

export function decodeLittleEndianNumber(hex: string | null | undefined): number {
  const normalized = String(hex ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return 0;
  const bytes = normalized.match(/.{2}/g);
  if (!bytes) return 0;
  return parseInt(bytes.reverse().join(''), 16);
}

export function formatBchFromSatoshis(satoshis: number): string {
  return (satoshis / 100_000_000).toFixed(4);
}

export function formatBlocksRemaining(
  endBlock: number,
  latestBlock: number | null
): string {
  if (!endBlock) return 'Unknown';
  if (!latestBlock) return `Ends at ${endBlock}`;

  const blocksRemaining = Math.max(endBlock - latestBlock, 0);
  if (blocksRemaining === 0) return 'Expired';

  const totalMinutes = blocksRemaining * 10;
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function parseLatestBlockHeight(latest: unknown): number | null {
  if (!latest || typeof latest !== 'object') return null;
  const maybeHeight = (latest as { height?: unknown }).height;
  return typeof maybeHeight === 'number' ? maybeHeight : null;
}

export function stripHexPrefix(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\\x/i, '')
    .replace(/^0x/i, '');
}

export function extractCampaignFromOutput(args: {
  output: FundMeChainOutput;
  latestBlock: number | null;
  hosted?: ShortCampaignPayload | null;
}): ChainCampaign | null {
  const { output, latestBlock, hosted } = args;
  const commitment = stripHexPrefix(output.nonfungible_token_commitment);
  if (!commitment || commitment.length < 80) return null;
  if (commitment.slice(70, 80) === 'ffffffffff') return null;
  if (
    output.nonfungible_token_capability !== 'minting' &&
    output.nonfungible_token_capability !== 'mutable'
  ) {
    return null;
  }

  const id = decodeLittleEndianNumber(commitment.slice(70, 80));
  const endBlock = decodeLittleEndianNumber(commitment.slice(52, 60));
  const targetSatoshis = decodeLittleEndianNumber(commitment.slice(0, 12));
  const status =
    output.nonfungible_token_capability === 'mutable' ? 'stopped' : 'active';

  return {
    id,
    txHash: stripHexPrefix(output.transaction_hash),
    outputIndex: output.output_index,
    capability: output.nonfungible_token_capability,
    targetSatoshis,
    raisedSatoshis: output.value_satoshis,
    endBlock,
    endLabel:
      status === 'stopped'
        ? `Stopped at ${endBlock}`
        : formatBlocksRemaining(endBlock, latestBlock),
    status,
    name: hosted?.name?.trim() || `Campaign #${id}`,
    owner: hosted?.owner?.trim() || 'FundMe',
    shortDescription:
      hosted?.shortDescription?.trim() ||
      'Campaign metadata is not currently available.',
    banner: hosted?.banner?.trim() || DEFAULT_BANNER,
  };
}

export function normalizeCampaignListPayload(payload: unknown): number[] {
  if (Array.isArray(payload)) {
    return payload
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0);
  }

  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { campaigns?: unknown[] }).campaigns)
  ) {
    return ((payload as { campaigns: unknown[] }).campaigns ?? [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0);
  }

  return [];
}

export function isChainCampaign(campaign: CampaignRecord): campaign is ChainCampaign {
  return campaign.status === 'active' || campaign.status === 'stopped';
}
