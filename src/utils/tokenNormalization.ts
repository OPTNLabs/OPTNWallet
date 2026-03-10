import { Token } from '../types/types';

export function normalizeTokenField(raw: unknown): Token | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw as Record<string, unknown>;
  const t = (candidate.token ??
    candidate.token_data ??
    candidate) as Record<string, unknown>;

  const categoryRaw = t.category ?? t.tokenCategory ?? t.categoryId;
  if (typeof categoryRaw !== 'string' || !categoryRaw.trim()) return null;

  let amount: number | bigint = 0;
  const rawAmount = t.amount;
  if (typeof rawAmount === 'bigint') {
    amount = rawAmount;
  } else if (typeof rawAmount === 'number' && Number.isFinite(rawAmount)) {
    amount = Math.trunc(rawAmount);
  } else if (typeof rawAmount === 'string') {
    const n = Number(rawAmount);
    amount = Number.isFinite(n) ? Math.trunc(n) : 0;
  }

  let nft: Token['nft'];
  if (t.nft && typeof t.nft === 'object') {
    const n = t.nft as Record<string, unknown>;
    const capabilityRaw = n.capability;
    const commitmentRaw = n.commitment;
    if (
      (capabilityRaw === 'none' ||
        capabilityRaw === 'mutable' ||
        capabilityRaw === 'minting') &&
      typeof commitmentRaw === 'string'
    ) {
      nft = {
        capability: capabilityRaw,
        commitment: commitmentRaw,
      };
    }
  }

  return {
    category: String(categoryRaw),
    amount,
    nft,
  };
}
