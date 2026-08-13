import { describe, expect, it } from 'vitest';
import {
  cashConnectProposalHasTransactions,
  listCashConnectActionNames,
} from '../cashconnectProposal';

describe('CashConnect proposal helpers', () => {
  it('lists action names and detects transaction instructions', () => {
    const proposal = {
      template: {
        name: 'Demo',
        actions: {
          getBalance: { instructions: [{ type: 'query' }] },
          send: { instructions: [{ type: 'transaction' }] },
        },
      },
    };

    expect(listCashConnectActionNames(proposal)).toEqual([
      'getBalance',
      'send',
    ]);
    expect(cashConnectProposalHasTransactions(proposal)).toBe(true);
  });

  it('treats query-only templates as non-transaction', () => {
    expect(
      cashConnectProposalHasTransactions({
        template: {
          actions: { getBalance: { instructions: [{ type: 'query' }] } },
        },
      })
    ).toBe(false);
    expect(listCashConnectActionNames({})).toEqual([]);
  });
});
