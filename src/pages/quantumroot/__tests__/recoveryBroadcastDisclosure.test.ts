import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workspaceSource = readFileSync(
  fileURLToPath(new URL('../useQuantumrootWorkspace.ts', import.meta.url)),
  'utf8'
);
const popupSource = readFileSync(
  fileURLToPath(new URL('../QuantumrootVaultPopup.tsx', import.meta.url)),
  'utf8'
);

describe('Quantumroot recovery broadcast disclosure', () => {
  it('keeps the broadcast transaction ID in the rendered recovery notice', () => {
    expect(workspaceSource).toContain('setRecoveryBroadcastNotice');
    expect(workspaceSource).toContain('messageKey: source.successKey');
    expect(workspaceSource).not.toContain('shortenTxHash(sent.txid)');
    expect(popupSource).toContain('recoveryBroadcastNotice.txid');
    expect(popupSource).toContain('<MaskedValue');
    expect(popupSource).toContain(
      'copySuccessMessageKey="history.transactionCopied"'
    );
  });
});
