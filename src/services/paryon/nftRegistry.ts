// ParyonUSD NFT type registry for the Assets NFT tab and the watch-only send
// workspace.
//
// ParyonUSD mints its NFTs on a single family of categories:
//   - The loan NFT lives in the ParyonUSD token category itself, carrying the
//     full loan state in its commitment (see the borrow flow in
//     transactions.ts, which builds it as:
//       01 || borrowedAmount(6 LE) || 000000000000 || 00
//       || periodBorrowing(4) || startingInterest(2) || startingInterest(2)
//       || interestManagerConfiguration(10)                 // 32 bytes total)
//   - The loan key that manages the loan is an NFT with commitment 0x01 in a
//     category derived from the LoanKeyFactory family (the codebase's own
//     transaction code recognises those categories with a startsWith check on
//     the factory token id).
//
// Loan-key categories are unique per loan (the factory genesis mints them), so
// no on-chain BCMR registry can describe them per category. The type registry
// below is therefore bundled: it ships the parse bytecode and field layout,
// and the Assets card builder falls back to it when category metadata is
// absent. Categories that carry their own BCMR v2 `nfts` schema (fetched
// through BcmrService) take precedence over this bundle.

import { Network } from '../../state/slices/networkSlice';
import { PARYON_MAINNET_V1_DEPLOYMENT } from './config';
import type { NftParseInfo } from '../nftParsing/nftParsing';

/**
 * Splits the 27-byte loan commitment into its fields.
 *
 * Bytecode grammar (chip-bcmr, validated against the libauth BCH 2026 VM):
 * `00cf` pushes OP_0 then the NFT commitment; every field after the 1-byte
 * type key is `<push length> OP_SPLIT OP_SWAP OP_TOALTSTACK`; the final
 * remainder is pushed with a bare OP_TOALTSTACK. Altstack order:
 * [typeKey, borrowedAmount, reserved, flags, periodBorrowing, startingInterest,
 *  currentInterest, interestManagerConfiguration].
 */
export const PARYON_LOAN_PARSE_BYTECODE =
  '00cf' +
  '51' + '7f7c6b' + // type key: 1 byte
  '56' + '7f7c6b' + // borrowed amount: 6 bytes (little endian)
  '56' + '7f7c6b' + // reserved: 6 zero bytes
  '51' + '7f7c6b' + // flags: 1 byte
  '54' + '7f7c6b' + // period borrowing: 4 bytes
  '52' + '7f7c6b' + // starting interest: 2 bytes
  '52' + '7f7c6b' + // current interest: 2 bytes
  '6b'; // interest manager configuration: remainder (10 bytes)

/** Loan-key NFTs carry a bare 0x01 commitment; the type key is the commitment. */
export const PARYON_LOAN_KEY_PARSE_BYTECODE = '00cf6b';

export const PARYON_LOAN_PARSE_INFO: NftParseInfo = {
  bytecode: PARYON_LOAN_PARSE_BYTECODE,
  types: {
    '01': {
      name: 'ParyonUSD Loan',
      description: 'Collateralised BCH loan against the ParyonUSD stablecoin.',
      fields: [
        'borrowedAmount',
        'reserved',
        'flags',
        'periodBorrowing',
        'startingInterest',
        'currentInterest',
        'interestManagerConfiguration',
      ],
    },
  },
  fields: {
    borrowedAmount: {
      name: 'Borrowed amount',
      encoding: { type: 'number', unit: 'PUSD' },
    },
    reserved: {
      name: 'Reserved',
      encoding: { type: 'hex' },
    },
    flags: {
      name: 'Flags',
      encoding: { type: 'hex' },
    },
    periodBorrowing: {
      name: 'Borrowing period',
      encoding: { type: 'hex' },
    },
    startingInterest: {
      name: 'Starting interest',
      encoding: { type: 'hex' },
    },
    currentInterest: {
      name: 'Current interest',
      encoding: { type: 'hex' },
    },
    interestManagerConfiguration: {
      name: 'Interest manager config',
      encoding: { type: 'hex' },
    },
  },
};

export const PARYON_LOAN_KEY_PARSE_INFO: NftParseInfo = {
  bytecode: PARYON_LOAN_KEY_PARSE_BYTECODE,
  types: {
    '01': {
      name: 'ParyonUSD Loan Key',
      description:
        'Authority NFT for managing a ParyonUSD loan (repay, add collateral).',
    },
  },
};

const deploymentFor = (network: Network) =>
  network === Network.CHIPNET ? null : PARYON_MAINNET_V1_DEPLOYMENT;

/** The shared category of every ParyonUSD protocol NFT on this network. */
export function paryonNftCategory(network: Network): string | null {
  return deploymentFor(network)?.tokenIds.paryonTokenId ?? null;
}

/**
 * Recognises a loan-key family category the same way the transaction code
 * does: exact match on the factory id (the origin proof), or the factory id
 * as a prefix (enforcer / loan keys derived from the factory genesis).
 */
export function isParyonLoanKeyCategory(
  network: Network,
  category: string
): boolean {
  const factoryId = deploymentFor(network)?.tokenIds.loanKeyFactoryTokenId;
  if (!factoryId) return false;
  const normalized = category.trim().toLowerCase();
  return (
    normalized === factoryId || normalized.startsWith(factoryId)
  );
}

/**
 * Parse info for a category without BCMR metadata of its own, or null when
 * the category is not part of the ParyonUSD family.
 */
export function resolveParyonNftParseInfo(
  network: Network,
  category: string
): NftParseInfo | null {
  const normalized = category.trim().toLowerCase();
  const familyCategory = paryonNftCategory(network);
  if (familyCategory && normalized === familyCategory) {
    return PARYON_LOAN_PARSE_INFO;
  }
  if (isParyonLoanKeyCategory(network, normalized)) {
    return PARYON_LOAN_KEY_PARSE_INFO;
  }
  return null;
}
