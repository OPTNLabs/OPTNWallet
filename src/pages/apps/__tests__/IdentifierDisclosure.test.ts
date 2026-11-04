import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const authGuardSource = readFileSync(
  join(process.cwd(), 'src/pages/apps/patient0/AuthGuardApp.tsx'),
  'utf8'
);
const paryonSource = readFileSync(
  join(process.cwd(), 'src/pages/apps/paryon/ParyonWorkspaceApp.tsx'),
  'utf8'
);
const fundMeSource = readFileSync(
  join(process.cwd(), 'src/pages/apps/fundme/CampaignDetail.tsx'),
  'utf8'
);

describe('add-on identifier disclosure', () => {
  it('keeps AuthGuard UTXO transaction IDs behind the shared disclosure', () => {
    expect(authGuardSource).toContain('value={u.tx_hash}');
    expect(authGuardSource).toContain(
      'copySuccessMessageKey="history.transactionCopied"'
    );
    expect(authGuardSource).toContain(
      "import { maskSensitiveValue } from '../../../utils/maskSensitiveValue';"
    );
    expect(authGuardSource).toContain('maskSensitiveValue(txid)');
  });

  it('keeps Paryon execution-plan transaction IDs behind the shared disclosure', () => {
    expect(paryonSource).toContain('value={plan.target.txHash}');
    expect(paryonSource).toContain("label={walletT('history.transactionId')}");
  });

  it('masks legacy FundMe broadcast toast transaction IDs', () => {
    expect(fundMeSource).toContain(
      "import { maskSensitiveValue } from '../../../utils/maskSensitiveValue';"
    );
    expect(fundMeSource).toContain('txid: maskSensitiveValue(result)');
    expect(fundMeSource).not.toContain(
      "'Pledge sent! TxID:\\n{txid}', {\n              txid: result"
    );
  });
});
