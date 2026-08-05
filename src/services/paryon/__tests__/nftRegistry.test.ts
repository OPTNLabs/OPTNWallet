import { describe, expect, it } from 'vitest';

import { Network } from '../../../state/slices/networkSlice';
import { parseNftCommitment } from '../../nftParsing/nftParsing';
import {
  isParyonLoanKeyCategory,
  paryonNftCategory,
  PARYON_LOAN_KEY_PARSE_INFO,
  PARYON_LOAN_PARSE_INFO,
  resolveParyonNftParseInfo,
} from '../nftRegistry';
import { PARYON_MAINNET_V1_DEPLOYMENT } from '../config';

const { paryonTokenId, loanKeyFactoryTokenId } =
  PARYON_MAINNET_V1_DEPLOYMENT.tokenIds;

const littleEndian = (value: bigint, bytes: number): string => {
  const out: string[] = [];
  let rest = value;
  for (let i = 0; i < bytes; i += 1) {
    out.push((rest & 0xffn).toString(16).padStart(2, '0'));
    rest >>= 8n;
  }
  return out.join('');
};

/** Builds a loan commitment exactly like the borrow flow in transactions.ts. */
function buildLoanCommitment(args: {
  borrowedAmount: bigint;
  periodBorrowing: number;
  startingInterest: number;
  interestManagerConfiguration: string;
}): string {
  const borrowedAmountBytes = littleEndian(args.borrowedAmount, 6);
  const zeroBytes6 = '000000000000';
  const periodBorrowing = args.periodBorrowing
    .toString(16)
    .padStart(8, '0')
    .slice(-8);
  const startingInterest = args.startingInterest
    .toString(16)
    .padStart(4, '0')
    .slice(-4);
  return (
    '01' +
    borrowedAmountBytes +
    zeroBytes6 +
    '00' +
    periodBorrowing +
    startingInterest +
    startingInterest +
    args.interestManagerConfiguration.padStart(10, '0').slice(0, 10)
  );
}

describe('ParyonUSD loan commitment parsing', () => {
  it('parses the 32-byte loan state into its fields', () => {
    const commitment = buildLoanCommitment({
      borrowedAmount: 125_000_000n,
      periodBorrowing: 144,
      startingInterest: 250,
      interestManagerConfiguration: '0100006400000064',
    });

    expect(commitment).toHaveLength(54);

    const result = parseNftCommitment(
      { commitment },
      PARYON_LOAN_PARSE_INFO
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.nftTypeKey).toBe('01');
    expect(result.nftTypeName).toBe('ParyonUSD Loan');
    expect(result.fields).toHaveLength(7);
    expect(result.fields[0]).toMatchObject({
      fieldId: 'borrowedAmount',
      name: 'Borrowed amount',
      parsedValue: {
        type: 'number',
        value: 125_000_000n,
        formatted: '125000000 PUSD',
      },
    });
    expect(result.fields[1]?.value).toBe('000000000000');
    expect(result.fields[3]?.parsedValue).toMatchObject({
      type: 'hex',
      formatted: '0x00000090',
    });
    expect(result.fields[4]?.parsedValue).toMatchObject({
      type: 'hex',
      formatted: '0x00fa',
    });
    expect(result.fields[6]?.value).toBe('0100006400');
  });

  it('parses a zero-value loan', () => {
    const result = parseNftCommitment(
      {
        commitment: buildLoanCommitment({
          borrowedAmount: 0n,
          periodBorrowing: 0,
          startingInterest: 0,
          interestManagerConfiguration: '00'.repeat(5),
        }),
      },
      PARYON_LOAN_PARSE_INFO
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.fields[0]?.parsedValue).toMatchObject({
      type: 'number',
      value: 0n,
    });
  });
});

describe('ParyonUSD loan key parsing', () => {
  it('parses the 0x01 commitment as a loan key with no fields', () => {
    const result = parseNftCommitment(
      { commitment: '01' },
      PARYON_LOAN_KEY_PARSE_INFO
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.nftTypeKey).toBe('01');
    expect(result.nftTypeName).toBe('ParyonUSD Loan Key');
    expect(result.fields).toHaveLength(0);
  });
});

describe('ParyonUSD family resolution', () => {
  it('exposes the protocol NFT category per network', () => {
    expect(paryonNftCategory(Network.MAINNET)).toBe(paryonTokenId);
    expect(paryonNftCategory(Network.CHIPNET)).toBeNull();
  });

  it('resolves the protocol category to the loan parse info', () => {
    const resolved = resolveParyonNftParseInfo(Network.MAINNET, paryonTokenId);
    expect(resolved?.bytecode).toBe(PARYON_LOAN_PARSE_INFO.bytecode);
  });

  it('resolves loan-key family categories the way the transaction code does', () => {
    expect(
      isParyonLoanKeyCategory(Network.MAINNET, loanKeyFactoryTokenId)
    ).toBe(true);
    // Enforcer / loan-key categories are factory-derived and share the prefix.
    const derived = `${loanKeyFactoryTokenId}02`;
    expect(isParyonLoanKeyCategory(Network.MAINNET, derived)).toBe(true);
    expect(
      resolveParyonNftParseInfo(Network.MAINNET, derived)?.bytecode
    ).toBe(PARYON_LOAN_KEY_PARSE_INFO.bytecode);
  });

  it('returns null for unknown categories and on chipnet', () => {
    expect(
      resolveParyonNftParseInfo(Network.MAINNET, 'ab'.repeat(32))
    ).toBeNull();
    expect(
      resolveParyonNftParseInfo(Network.CHIPNET, paryonTokenId)
    ).toBeNull();
    expect(
      isParyonLoanKeyCategory(Network.CHIPNET, loanKeyFactoryTokenId)
    ).toBe(false);
  });
});
