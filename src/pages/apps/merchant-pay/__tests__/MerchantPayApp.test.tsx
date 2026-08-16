import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import MerchantPayApp from '../MerchantPayApp';
import { Network } from '../../../../state/slices/networkSlice';
import { buildMerchantPaymentRequest } from '../merchantPayRequest';
import { toTokenAwareCashAddress } from '../../../../utils/cashAddress';
import { CAULDRON_NATIVE_BCH } from '../../../../services/cauldron';
import { I18nContext } from '../../../../i18n/I18nContext';
import { translate } from '../../../../i18n/translate';
import { AddonModuleI18nProvider } from '../../../../i18n/AddonModuleI18nProvider';

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/apps/merchant-pay' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({
      wallet_id: { currentWalletId: 1 },
      preferences: { locale: 'en' },
    }),
}));

vi.mock('../../../../state/selectors/networkSelectors', () => ({
  selectCurrentNetwork: () => 'mainnet',
}));

vi.mock('../../../../components/ui/WalletScreen', () => ({
  default: ({
    children,
    scrollable,
    maxWidthClassName,
  }: {
    children: ReactNode;
    scrollable?: boolean;
    maxWidthClassName?: string;
  }) => (
    <div
      data-scrollable={String(scrollable)}
      data-max-width={maxWidthClassName}
    >
      {children}
    </div>
  ),
}));

vi.mock('../../../../services/cauldron', () => ({
  CAULDRON_NATIVE_BCH: 'bch',
  CauldronApiClient: class {},
  fetchNormalizedCauldronPools: vi.fn(),
  planAggregatedTradeForTargetDemand: vi.fn(
    (pools, _supply, demand, amount) => {
      const pool = pools[0];
      if (!pool) return null;
      const trade = {
        supplyTokenId: CAULDRON_NATIVE_BCH,
        demandTokenId: demand,
        supply: 8_400_000n,
        demand: amount,
        tradeFee: 10n,
        pool,
      };
      return {
        trades: [trade],
        summary: {
          supply: trade.supply,
          demand: trade.demand,
          tradeFee: trade.tradeFee,
          rateNumerator: 1n,
          rateDenominator: 1n,
        },
      };
    }
  ),
}));

vi.mock('../../cauldron/preflight', () => ({
  fetchCurrentCauldronPools: vi.fn(async () => []),
  fetchCurrentLiquidityPoolsFromChain: vi.fn(async ({ quotedPools }) => ({
    currentPools: quotedPools,
    missingQuotedPoolCount: 0,
  })),
  fetchCurrentQuotedPoolsFromChain: vi.fn(async ({ quotedPools }) => ({
    resolvedPools: quotedPools,
    missingQuotedPoolCount: 0,
  })),
}));

vi.mock('../../../../services/cauldron/amount', () => ({
  parseDecimalToAtomic: () => 0n,
}));

vi.mock('../../shared/useSmoothResetTransition', () => ({
  useSmoothResetTransition: () => ({
    contentClassName: '',
    runSmoothReset: async (task: () => void) => task(),
  }),
}));

describe('MerchantPayApp', () => {
  it('renders the merchant screen without enabling wallet scrolling', () => {
    const html = renderToStaticMarkup(
      <I18nContext.Provider
        value={{
          locale: 'en',
          setLocale: vi.fn(),
          t: (key, values) => translate('en', key, values),
        }}
      >
        <AddonModuleI18nProvider moduleId="merchant-pay">
          <MerchantPayApp
            sdk={{ wallet: { listAddresses: vi.fn() } } as never}
            manifest={{ id: 'optn.builtin.merchant-pay' } as never}
            app={{ name: 'Merchant Pay' } as never}
          />
        </AddonModuleI18nProvider>
      </I18nContext.Provider>
    );

    expect(html).toContain('data-scrollable="false"');
    expect(html).toContain('Choose stablecoin.');
    expect(html).toContain('Continue');
  });

  it('builds a merchant transaction proposal from the current LP route', async () => {
    const tokenId =
      'b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366';
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: new Uint8Array(20) },
      txHash: 'bb'.repeat(32),
      outputIndex: 0,
      ownerPublicKeyHash: null,
      ownerAddress: null,
      poolId: null,
      output: {
        amountSatoshis: 10_000_000n,
        tokenCategory: tokenId,
        tokenAmount: 10_000n,
        lockingBytecode: new Uint8Array([0x51]),
      },
    };
    const trade = {
      supplyTokenId: CAULDRON_NATIVE_BCH,
      demandTokenId: tokenId,
      supply: 8_400_000n,
      demand: 1_000n,
      tradeFee: 10n,
      pool,
    };
    const request = await buildMerchantPaymentRequest({
      sdk: {
        utxos: {
          listForAddress: vi.fn(async () => [
            {
              address: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
              tokenAddress:
                'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
              tx_hash: 'aa'.repeat(32),
              tx_pos: 1,
              value: 12_345,
              amount: 12_345,
              height: 12,
            },
          ]),
        },
        wallet: {
          listAddresses: vi.fn(async () => [
            {
              address: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
            },
          ]),
        },
      } as never,
      currentNetwork: Network.MAINNET,
      selectedStablecoin: {
        tokenId,
        symbol: 'MUSD',
        name: 'Moria USD',
        decimals: 2,
      },
      draftQuote: {
        createdAt: 1_000_000,
        expiresAt: Date.now() + 120_000,
        merchantReceivesAtomic: 1_000n,
        merchantReceivesDisplay: '10.00 MUSD',
        customerPaysSats: 8_400_000n,
        customerPaysDisplay: '0.084 BCH',
        routePoolCount: 2,
        quoteProtectionBps: 100n,
        trades: [trade],
      },
    });

    expect(request.merchantReceivesDisplay).toBe('10.00 MUSD');
    expect(request.customerPaysDisplay).toBe('0.084 BCH');
    expect(request.merchantAddress).toBe(
      toTokenAwareCashAddress(
        'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
      )
    );
    expect(request.proposal.kind).toBe('cauldron-merchant-payment-proposal');
    expect(request.proposal.route.trades[0]?.pool.txHash).toBe('bb'.repeat(32));
    expect(request.proposalPayload.length).toBeGreaterThan(0);
    expect(request.detailsText).toContain('OPTN Merchant transaction proposal');
    expect(request.detailsText).toContain('Quote protection: 1.00%');
    expect(request.merchantAddressBaselineOutpoints).toEqual([
      `${'aa'.repeat(32)}:1`,
    ]);
  });
});
