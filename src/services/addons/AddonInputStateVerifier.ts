import type { UTXO } from '../../types/types';
import type { AddonTransactionProposal } from '../AddonsSDK';
import { MAX_CASHTOKEN_AMOUNT, MAX_NFT_COMMITMENT_HEX_LENGTH } from './CashTokenProposalValidator';

function outpointKey(txid: string, vout: number): string {
  return `${txid.toLowerCase()}:${vout}`;
}

function assertOutpoint(txid: unknown, vout: unknown, label: string): void {
  if (
    typeof txid !== 'string' ||
    !/^[0-9a-f]{64}$/.test(txid) ||
    typeof vout !== 'number' ||
    !Number.isSafeInteger(vout) ||
    vout < 0 ||
    vout > 0xffffffff
  ) {
    throw new Error(`${label} outpoint is invalid`);
  }
}

function valueSats(utxo: UTXO): bigint {
  const value = utxo.value ?? utxo.amount;
  if (value === undefined || value === null) {
    throw new Error(
      `Wallet input ${utxo.tx_hash}:${utxo.tx_pos} has no BCH value`
    );
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(
      `Wallet input ${utxo.tx_hash}:${utxo.tx_pos} has an unsafe BCH value`
    );
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(
      `Wallet input ${utxo.tx_hash}:${utxo.tx_pos} has an invalid BCH value`
    );
  }
}

function tokenState(utxo: UTXO): {
  category: string;
  amount: bigint;
  nft?: { capability: string; commitment: string };
} | null {
  if (utxo.token && utxo.token_data) {
    const comparable = (value: typeof utxo.token) => ({
      category: String(value.category).toLowerCase(),
      amount: String(value.amount),
      nft: value.nft
        ? {
            capability: value.nft.capability,
            commitment: String(value.nft.commitment).toLowerCase(),
          }
        : null,
    });
    const primary = comparable(utxo.token);
    const legacy = comparable(utxo.token_data);
    if (JSON.stringify(primary) !== JSON.stringify(legacy)) {
      throw new Error(
        `Wallet input ${utxo.tx_hash}:${utxo.tx_pos} has conflicting token state`
      );
    }
  }
  const token = utxo.token ?? utxo.token_data;
  if (!token) return null;
  if (
    typeof token.amount === 'number' &&
    !Number.isSafeInteger(token.amount)
  ) {
    throw new Error(
      `Wallet input ${utxo.tx_hash}:${utxo.tx_pos} has an unsafe token amount`
    );
  }
  let amount: bigint;
  try {
    amount = BigInt(token.amount);
  } catch {
    throw new Error(
      `Wallet input ${utxo.tx_hash}:${utxo.tx_pos} has an invalid token amount`
    );
  }
  const category = String(token.category).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(category)) {
    throw new Error(
      `Wallet input ${utxo.tx_hash}:${utxo.tx_pos} has an invalid token category`
    );
  }
  if (amount < 0n || amount > MAX_CASHTOKEN_AMOUNT) {
    throw new Error(
      `Wallet input ${utxo.tx_hash}:${utxo.tx_pos} has an invalid token amount`
    );
  }
  if (amount === 0n && !token.nft) {
    throw new Error(
      `Wallet input ${utxo.tx_hash}:${utxo.tx_pos} has a zero fungible token amount`
    );
  }
  if (
    token.nft &&
    (!['none', 'mutable', 'minting'].includes(token.nft.capability) ||
      !/^[0-9a-f]*$/i.test(String(token.nft.commitment)) ||
      String(token.nft.commitment).length % 2 !== 0 ||
      String(token.nft.commitment).length > MAX_NFT_COMMITMENT_HEX_LENGTH)
  ) {
    throw new Error(
      `Wallet input ${utxo.tx_hash}:${utxo.tx_pos} has invalid NFT metadata`
    );
  }
  return {
    category,
    amount,
    ...(token.nft
      ? {
          nft: {
            capability: token.nft.capability,
            commitment: String(token.nft.commitment).toLowerCase(),
          },
        }
      : {}),
  };
}

function expectedTokenState(input: AddonTransactionProposal['inputs'][number]) {
  if (!input.tokenCategory) return null;
  if (input.tokenAmount === undefined) {
    throw new Error(
      `Addon proposal input ${input.txid}:${input.vout} has no token amount`
    );
  }
  let amount: bigint;
  try {
    amount = BigInt(input.tokenAmount);
  } catch {
    throw new Error(
      `Addon proposal input ${input.txid}:${input.vout} has an invalid token amount`
    );
  }
  return {
    category: input.tokenCategory.toLowerCase(),
    amount,
    ...(input.tokenNft ? { nft: { ...input.tokenNft } } : {}),
  };
}

/**
 * Compares caller-supplied proposal inputs to a fresh wallet-owned UTXO set.
 * The proposal is never treated as proof of value, token state, ownership, or
 * spendability. This function is pure so each host can provide its own
 * chain/provider resolution and still share the comparison invariant.
 */
export function assertAddonWalletInputState(args: {
  proposal: AddonTransactionProposal;
  actualInputs: UTXO[];
}): void {
  const { proposal, actualInputs } = args;
  const actualByOutpoint = new Map<string, UTXO>();
  for (const actual of actualInputs) {
    assertOutpoint(actual.tx_hash, actual.tx_pos, 'Wallet input');
    const key = outpointKey(actual.tx_hash, actual.tx_pos);
    if (actualByOutpoint.has(key)) {
      throw new Error(`Wallet input set contains duplicate outpoint: ${key}`);
    }
    actualByOutpoint.set(key, actual);
  }

  const seen = new Set<string>();
  for (const expected of proposal.inputs) {
    assertOutpoint(expected.txid, expected.vout, 'Addon input');
    const key = outpointKey(expected.txid, expected.vout);
    if (seen.has(key)) {
      throw new Error(`Addon proposal contains duplicate input: ${key}`);
    }
    seen.add(key);
    const actual = actualByOutpoint.get(key);
    if (!actual) throw new Error(`Addon input is no longer spendable: ${key}`);
    if (actual.address !== expected.address) {
      throw new Error(`Addon input address changed for ${key}`);
    }
    if (actual.contractName || actual.abi || actual.contractFunction) {
      throw new Error(`Addon input is a contract UTXO: ${key}`);
    }
    if (valueSats(actual) !== BigInt(expected.valueSats)) {
      throw new Error(`Addon input BCH value changed for ${key}`);
    }

    const actualToken = tokenState(actual);
    const expectedToken = expectedTokenState(expected);
    if (!actualToken && !expectedToken) continue;
    if (!actualToken || !expectedToken) {
      throw new Error(`Addon input token state changed for ${key}`);
    }
    if (
      actualToken.category !== expectedToken.category ||
      actualToken.amount !== expectedToken.amount ||
      JSON.stringify(actualToken.nft ?? null) !==
        JSON.stringify(expectedToken.nft ?? null)
    ) {
      throw new Error(`Addon input token state changed for ${key}`);
    }
  }
}
