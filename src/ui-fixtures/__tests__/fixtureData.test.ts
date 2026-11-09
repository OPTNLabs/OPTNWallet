import { describe, expect, it } from 'vitest';
import {
  getUiFixtureOutboundRecords,
  getUiFixtureReview,
  getUiFixtureCashConnectAction,
  getUiFixtureBuilderReview,
  getUiFixtureWizardConnections,
  getUiFixtureWizardSignRequest,
  getUiFixtureWalletConnectRequest,
  getUiFixtureTransactions,
  getUiFixtureWalletEffects,
  getUiFixtureUtxos,
  UI_FIXTURE_WALLET_ID,
} from '../fixtureData';

describe('UI fixture data', () => {
  it('contains disposable public wallet state for the authenticated screens', () => {
    const utxos = getUiFixtureUtxos();
    const transactions = getUiFixtureTransactions();
    const outbox = getUiFixtureOutboundRecords();

    expect(Object.values(utxos).flat()).toHaveLength(2);
    expect(transactions).toHaveLength(2);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.walletId).toBe(UI_FIXTURE_WALLET_ID);
    expect(outbox[0]?.verificationPending).toBe(true);
    expect(getUiFixtureWalletEffects()).toMatchObject({
      [transactions[0]?.tx_hash ?? 'missing']: 12_500_000,
    });
  });

  it('does not carry signing material or wallet secrets', () => {
    const serialized = JSON.stringify({
      utxos: getUiFixtureUtxos(),
      transactions: getUiFixtureTransactions(),
      outbox: getUiFixtureOutboundRecords(),
    });

    expect(serialized).not.toMatch(/mnemonic|privateKey|seed|passphrase/i);
  });

  it('provides state-matrix variants for freshness, history, and outbox review', () => {
    expect(getUiFixtureTransactions('history-empty')).toEqual([]);
    expect(getUiFixtureTransactions('history-error')).toEqual([]);
    expect(getUiFixtureOutboundRecords('outbox-empty')).toEqual([]);

    const stale = getUiFixtureOutboundRecords('outbox-stale')[0];
    expect(stale.state).toBe('broadcasting');
    expect(stale.verificationPending).toBe(false);

    const unknown = getUiFixtureOutboundRecords('outbox-unknown')[0];
    expect(unknown.lastError).toContain('Network timeout');
    expect(unknown.verificationPending).toBe(false);
  });

  it('provides a display-only review without signing material', () => {
    const review = getUiFixtureReview();

    expect(review.feeSats).toBe(250);
    expect(review.finalOutputs[0]).toMatchObject({
      recipientAddress: 'bchtest:qp63uahgrxged4z5jswyt5dn5v3lzsem6cq85x00dt',
      amount: 10_000_000,
    });
    expect(review.rawTx).toMatch(/^00+$/);
  });

  it('provides a public-only connector review request', () => {
    const request = getUiFixtureWalletConnectRequest();
    const params = request.params.request.params;

    expect(params.broadcast).toBe(false);
    expect(params.sourceOutputs).toHaveLength(1);
    expect(params.transaction.outputs).toHaveLength(1);
    expect(
      JSON.stringify(request, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      )
    ).not.toMatch(/mnemonic|privateKey|seed/i);
  });

  it('provides public-only WizardConnect and request-reported CashConnect reviews', () => {
    const wizard = getUiFixtureWizardSignRequest();
    const wizardConnections = getUiFixtureWizardConnections();
    const cash = getUiFixtureCashConnectAction();
    const serialized = JSON.stringify(
      { wizard, wizardConnections, cash },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value)
    );

    expect(wizard.connectionId).toBe('ui-fixture-wizard');
    expect(wizard.request.transaction.sourceOutputs).toHaveLength(1);
    expect(wizard.request.transaction.broadcast).toBe(false);
    expect(wizardConnections['ui-fixture-wizard']?.dappName).toBe(
      'Fixture dApp'
    );
    expect(cash.response.transactions).toHaveLength(1);
    expect(cash.response.balanceChanges.sats).toBe(-150_000n);
    expect(serialized).not.toMatch(/mnemonic|privateKey|seed|signingKey/i);

    expect(
      getUiFixtureWizardSignRequest('wizardconnect-invalid').request.transaction
        .sourceOutputs
    ).toHaveLength(0);
    expect(
      getUiFixtureCashConnectAction('cashconnect-empty').response.transactions
    ).toHaveLength(0);
    expect(
      getUiFixtureCashConnectAction('cashconnect-multi').response.transactions
    ).toHaveLength(2);

    const builder = getUiFixtureBuilderReview();
    expect(builder.rawTx).toMatch(/^00+$/);
    expect(builder.selectedUtxos[0]?.value).toBe(10_000_000);
    expect(builder.txOutputs).toHaveLength(2);
    expect(
      getUiFixtureBuilderReview('builder-token-error').selectedUtxos[0]?.token
        ?.category
    ).toHaveLength(64);
  });
});
