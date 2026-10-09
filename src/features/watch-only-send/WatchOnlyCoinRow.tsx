// One coin in the watch-only "Coins to spend" list.
//
// Presentation only. What the coin carries and whether a BCH send may take it
// arrive from Rust as a CoinControlLabel; this renders that and decides
// nothing. A token coin is shown by what it carries -- ticker or name, amount,
// category -- and is kept out of a BCH send's selection, because a BCH send
// has no token output for it and would destroy its tokens. A token send may
// take it: Rust then gives every token it carries an output.
import type { ReactNode } from 'react';

import { useI18n } from '../../i18n/useI18n';
import type { CoinControlLabel } from '../../services/psbt/coinControlLabels';

export type WatchOnlyCoinRowProps = {
  /** `txid:vout`, already shortened for display. */
  outpoint: string;
  /** BCH value, address branch and local badges. */
  detail: ReactNode;
  /** Null while labels are unavailable; the row then shows only its outpoint. */
  label: CoinControlLabel | null;
  checked: boolean;
  onToggle: () => void;
  testId: string;
  /** Extra detail under the row, such as an NFT card. */
  children?: ReactNode;
  /**
   * The send moves tokens, so a token coin may be picked: its tokens go to
   * the recipient or back to the wallet, as the Rust plan says.
   */
  tokenSend?: boolean;
};

export function WatchOnlyCoinRow({
  outpoint,
  detail,
  label,
  checked,
  onToggle,
  testId,
  children,
  tokenSend = false,
}: WatchOnlyCoinRowProps) {
  const { t } = useI18n();
  const tokens = label && label.kind !== 'bch' ? label : null;
  const refusal = label?.bch_send_refusal ?? null;
  // A coin selected before (a restored proposal) can still be deselected.
  const locked = !tokenSend && refusal !== null && !checked;
  const badge =
    tokens?.kind === 'fungible'
      ? t('utxo.ft')
      : tokens?.kind === 'nft'
        ? t('utxo.nft')
        : tokens?.kind === 'fungible_nft'
          ? `${t('utxo.ft')} + ${t('utxo.nft')}`
          : null;
  const identityLine = tokens
    ? [tokens.name, tokens.category_short].filter(Boolean).join(' · ')
    : '';

  return (
    <label
      data-testid={testId}
      className={`flex items-center gap-2 rounded-md border border-[var(--wallet-border)] px-2.5 py-2 text-xs ${
        locked ? 'cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={locked}
        onChange={onToggle}
        className="accent-[var(--wallet-accent)]"
      />
      <span className="min-w-0 flex-1">
        {tokens && (
          <span className="mb-0.5 flex flex-wrap items-center gap-1.5">
            <span className="font-semibold wallet-text-strong">
              {tokens.amount ? `${tokens.amount} ` : ''}
              {tokens.title}
            </span>
            {badge && (
              <span className="rounded border border-[var(--wallet-border)] px-1 text-[10px] uppercase tracking-wide wallet-muted">
                {badge}
              </span>
            )}
            {tokens.nft_capability && (
              <span className="text-[10px] wallet-muted">
                {tokens.nft_capability}
              </span>
            )}
            {tokens.caveat && (
              <span className="text-[10px] wallet-warning-text">
                {tokens.caveat}
              </span>
            )}
          </span>
        )}
        {identityLine && (
          <span className="block truncate font-mono text-[10px] wallet-muted">
            {identityLine}
          </span>
        )}
        <span className="block truncate font-mono wallet-text-strong">
          {outpoint}
        </span>
        <span className="block wallet-muted">{detail}</span>
        {children}
        {locked && (
          <span className="mt-0.5 block text-[10px] wallet-muted">
            Kept out of this BCH send: {refusal}.
          </span>
        )}
      </span>
    </label>
  );
}

export default WatchOnlyCoinRow;
