import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../cashconnectSlice.ts', import.meta.url)),
  'utf8'
);

describe('cashconnectSlice approve/reject', () => {
  it('does not call the CashConnect service from a reducer', () => {
    const reducersStart = source.indexOf('reducers: {');
    const thunksStart = source.indexOf(
      'export const approveCashConnectProposalAction'
    );
    const reducers = source.slice(reducersStart, thunksStart);
    expect(thunksStart).toBeGreaterThan(reducersStart);
    expect(reducers).not.toContain('approveCashConnectProposal()');
    expect(reducers).not.toContain('rejectCashConnectProposal()');
    expect(source).toContain("'cashconnect/approveProposal'");
    expect(source).toContain("'cashconnect/rejectProposal'");
  });
});
