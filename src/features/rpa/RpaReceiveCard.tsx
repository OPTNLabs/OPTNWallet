// RPA receive card — shown in the Receive screen when RPA is enabled.
// Displays the BCH Reusable Payment Address (paycode) in CashAddr format.
// No notification transactions — the protocol uses signature grinding instead.

import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { QRCodeSVG } from 'qrcode.react';
import { Toast } from '@capacitor/toast';
import { selectRpaEnabled } from '../../state/slices/experimentalSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import {
  deriveAndEncodePaycode,
  getRpaKeyPaths,
  RPA_PREFIX_BITS,
} from '../../services/RpaService';
import WalletManager from '../../apis/WalletManager/WalletManager';
import { Network } from '../../state/slices/networkSlice';
import { selectWalletDerivationPath } from '../../state/slices/walletSlice';

type RpaReceiveCardProps = {
  walletId: number;
};

export const RpaReceiveCard: React.FC<RpaReceiveCardProps> = ({ walletId }) => {
  const rpaEnabled = useSelector(selectRpaEnabled);
  const network = useSelector(selectCurrentNetwork);
  const derivationPath = useSelector(selectWalletDerivationPath);

  const [paycode, setPaycode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!rpaEnabled || !walletId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    const derive = async () => {
      try {
        const walletManager = WalletManager();
        const info = await walletManager.getWalletInfo(walletId);
        if (!info?.mnemonic) throw new Error('Wallet not available');

        const code = await deriveAndEncodePaycode(
          info.mnemonic,
          info.passphrase ?? '',
          network,
          RPA_PREFIX_BITS,
          derivationPath || undefined,
        );
        if (!cancelled) setPaycode(code);
      } catch (err) {
        if (!cancelled) setError('Paycode derivation failed. Unlock your wallet and try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void derive();
    return () => { cancelled = true; };
  }, [rpaEnabled, walletId, network, derivationPath]);

  if (!rpaEnabled) return null;

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      await Toast.show({ text: 'Paycode copied!' });
    } catch {
      await Toast.show({ text: 'Copy failed.' });
    }
  };

  const networkLabel = network === Network.MAINNET ? 'mainnet' : 'chipnet';
  const rpaKeyPaths = getRpaKeyPaths(network, derivationPath || undefined);

  return (
    <div className="rounded-xl border border-[var(--wallet-accent)]/30 bg-[var(--wallet-surface)] overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold wallet-text-strong">RPA Paycode</span>
          <span className="rounded-full border border-[var(--wallet-accent)]/40 bg-[var(--wallet-accent)]/10 px-2 py-0.5 text-[10px] font-bold text-[var(--wallet-accent)] uppercase tracking-wide">
            BCH RPA
          </span>
          <span className="rounded-full border border-purple-500/40 bg-purple-500/10 px-2 py-0.5 text-[10px] font-semibold text-purple-400 uppercase tracking-wide">
            {networkLabel}
          </span>
        </div>
        <span className="wallet-muted text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--wallet-border)] px-4 pb-4 pt-3 space-y-4">
          {loading && (
            <p className="text-xs wallet-muted text-center py-2">Deriving paycode…</p>
          )}

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}

          {paycode && (
            <>
              {/* QR code — same tap-to-copy as the Receive address QR above */}
              <div className="flex flex-col items-center gap-3">
                <button
                  type="button"
                  className="rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white p-2 shadow-sm transition-transform duration-200 hover:scale-[1.01] focus:outline-none focus:ring-2 focus:ring-[var(--wallet-accent)] focus:ring-offset-2"
                  onClick={() => void handleCopy(paycode)}
                  aria-label="Copy paycode"
                  title="Tap to copy paycode"
                >
                  <QRCodeSVG
                    value={paycode}
                    size={160}
                    bgColor="#ffffff"
                    fgColor="#000000"
                    level="M"
                    marginSize={1}
                  />
                </button>
                <p className="text-[10px] wallet-muted text-center max-w-[240px] leading-relaxed">
                  Tap the QR to copy the paycode. Each payment creates a unique stealth address —
                  no link between payments on-chain.
                </p>
              </div>

              {/* Paycode string */}
              <div className="space-y-1">
                <p className="text-[10px] font-semibold wallet-muted uppercase tracking-wide">
                  Paycode
                </p>
                <button
                  type="button"
                  onClick={() => void handleCopy(paycode)}
                  className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface-strong)] px-3 py-2 text-left font-mono text-[11px] wallet-text-strong break-all hover:brightness-95 transition-all"
                >
                  {paycode}
                </button>
              </div>

              {/* Protocol info */}
              <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3 space-y-1.5">
                <p className="text-[10px] font-semibold wallet-muted uppercase tracking-wide">How it works</p>
                <div className="text-[10px] wallet-muted space-y-1 leading-relaxed">
                  <p>
                    <span className="wallet-text-strong">No notification tx.</span>{' '}
                    The sender grinds their signature nonce until the input hash prefix
                    matches your scan key — detectability is embedded in the signature itself.
                  </p>
                  <p>
                    <span className="wallet-text-strong">Prefix filter:</span>{' '}
                    {RPA_PREFIX_BITS} bits → 1/{Math.pow(2, RPA_PREFIX_BITS)} false-positive rate
                    when scanning the Fulcrum-RPA server.
                  </p>
                </div>
              </div>

              {/* Key paths */}
              <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3 space-y-1">
                <p className="text-[10px] font-semibold wallet-muted uppercase tracking-wide">Derivation paths</p>
                <div className="font-mono text-[10px] wallet-muted space-y-0.5">
                  <p>Scan key: <span className="wallet-text-strong">{rpaKeyPaths.scan}</span></p>
                  <p>Spend key: <span className="wallet-text-strong">{rpaKeyPaths.spend}</span></p>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
