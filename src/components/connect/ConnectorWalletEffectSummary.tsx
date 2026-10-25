import { useEffect, useState } from 'react';
import {
  deriveConnectorWalletEffect,
  type ConnectorWalletEffect,
} from '../../services/connect/connectorWalletEffect';
import type { ConnectorTransactionPreview } from '../../services/connect/transactionPreview';
import { loadWalletPublicAddresses } from '../../services/connect/walletPublicAddresses';

type Props = {
  preview: ConnectorTransactionPreview;
  walletId: number;
};

function signedAmount(value: bigint, unit: string): string {
  const sign = value > 0n ? '+' : value < 0n ? '−' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute.toString()} ${unit}`;
}

function bchEffect(value: bigint): string {
  const sign = value > 0n ? '+' : value < 0n ? '−' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${(Number(absolute) / 100_000_000).toFixed(8)} BCH`;
}

export default function ConnectorWalletEffectSummary({
  preview,
  walletId,
}: Props) {
  const [effect, setEffect] = useState<ConnectorWalletEffect | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading'
  );

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setEffect(null);
    void (async () => {
      try {
        if (!walletId) throw new Error('No wallet selected');
        const addresses = await loadWalletPublicAddresses(walletId);
        const next = deriveConnectorWalletEffect(preview, addresses);
        if (cancelled) return;
        setEffect(next);
        setStatus(
          next.ownedInputCount > 0 || next.ownedOutputCount > 0
            ? 'ready'
            : 'unavailable'
        );
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [preview, walletId]);

  if (status === 'loading') {
    return (
      <div role="status" className="wallet-card p-3 text-sm wallet-muted">
        Verifying this wallet’s inputs and change…
      </div>
    );
  }

  if (status !== 'ready' || !effect) {
    return (
      <div
        role="status"
        className="wallet-warning-panel rounded-xl p-3 text-sm"
      >
        Wallet-owned inputs and change could not be verified from this request.
        Review the whole transaction details carefully before signing.
      </div>
    );
  }

  return (
    <div role="status" className="wallet-card p-3 text-sm space-y-2">
      <div className="font-semibold wallet-text-strong">
        Verified wallet effect
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="wallet-muted">BCH balance change</span>
        <span className="font-medium wallet-text-strong">
          {bchEffect(effect.bchDeltaSats)}
        </span>
      </div>
      {effect.tokenEffects.map((token) => (
        <div
          key={token.category}
          className="rounded-lg border border-[var(--wallet-border)] p-2 space-y-1"
        >
          <div className="wallet-muted text-xs">Token category</div>
          <div className="break-all font-mono text-xs wallet-text-strong">
            {token.category}
          </div>
          {token.fungibleDelta !== 0n ? (
            <div className="flex items-center justify-between gap-3">
              <span className="wallet-muted">Token atoms</span>
              <span className="font-medium wallet-text-strong">
                {signedAmount(token.fungibleDelta, 'atoms')}
              </span>
            </div>
          ) : null}
          {token.nftDelta !== 0 ? (
            <div className="flex items-center justify-between gap-3">
              <span className="wallet-muted">NFTs</span>
              <span className="font-medium wallet-text-strong">
                {token.nftDelta > 0 ? '+' : ''}
                {token.nftDelta}
              </span>
            </div>
          ) : null}
        </div>
      ))}
      <p className="text-xs wallet-muted">
        Matched {effect.ownedInputCount} wallet input
        {effect.ownedInputCount === 1 ? '' : 's'} and {effect.ownedOutputCount}{' '}
        wallet output{effect.ownedOutputCount === 1 ? '' : 's'} by locking
        bytecode. Whole-transaction fees can include other participants.
      </p>
    </div>
  );
}
