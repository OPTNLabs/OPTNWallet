import { describe, expect, it } from 'vitest';
import { buildBip21Uri, parseBip21Uri } from '../bip21';
import { Network } from '../../redux/networkSlice';

const VALID_CASHADDR =
  'bitcoincash:qrx6fypj230kpgvghmyje089sphvl4jnfqq4aduatz';
const VALID_BASE58 = '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu';

describe('parseBip21Uri', () => {
  it('normalizes duplicate prefixes and parses amount', () => {
    const parsed = parseBip21Uri(
      `bitcoincash:${VALID_CASHADDR}?amount=0.12345678&label=OPTN`,
      Network.MAINNET
    );

    expect(parsed.isValidAddress).toBe(true);
    expect(parsed.normalizedAddress).toBe(VALID_CASHADDR);
    expect(parsed.amountRaw).toBe('0.12345678');
    expect(parsed.label).toBe('OPTN');
  });

  it('accepts base58 URI payloads', () => {
    const parsed = parseBip21Uri(
      `bitcoincash:${VALID_BASE58}?amount=0.01`,
      Network.MAINNET
    );

    expect(parsed.isValidAddress).toBe(true);
    expect(parsed.isBase58Address).toBe(true);
    expect(parsed.normalizedAddress).toBe(VALID_BASE58);
    expect(parsed.amount).toBe(0.01);
  });
});

describe('buildBip21Uri', () => {
  it('builds canonical uri with scheme and query params', () => {
    const uri = buildBip21Uri(VALID_CASHADDR, Network.MAINNET, {
      amount: '0.5',
      message: 'Thanks',
    });

    expect(uri).toBe(
      'bitcoincash:qrx6fypj230kpgvghmyje089sphvl4jnfqq4aduatz?amount=0.5&message=Thanks'
    );
  });
});
