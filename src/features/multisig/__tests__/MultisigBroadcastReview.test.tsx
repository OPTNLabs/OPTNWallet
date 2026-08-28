import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { describe, expect, it } from 'vitest';

import { store } from '../../../state/store';
import { I18nProvider } from '../../../i18n/I18nProvider';
import MultisigBroadcastReview from '../MultisigBroadcastReview';

describe('MultisigBroadcastReview', () => {
  it('uses the standard review interaction while identifying the policy', () => {
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <I18nProvider>
          <MultisigBroadcastReview
            open
            recipient="bchtest:qqexampledestination"
            amountSats={99_000n}
            inputSumSats={100_000n}
            feeSats={1_000n}
            outputs={[]}
            selectedInputs={[]}
            rawTxHex="00"
            network="chipnet"
            policyId="policy-123"
            threshold={2}
            signerCount={2}
            isSending={false}
            onClose={() => undefined}
            onConfirmSend={() => undefined}
          />
        </I18nProvider>
      </Provider>
    );

    expect(html).toContain('Review Transaction');
    expect(html).toContain('Multisig policy policy-123');
    expect(html).toContain('2 of 2 signatures');
    expect(html).toContain('Slide to confirm');
  });
});
