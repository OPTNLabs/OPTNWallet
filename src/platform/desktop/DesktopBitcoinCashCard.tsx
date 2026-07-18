// Desktop balance card — swapped in for src/components/BitcoinCashCard.tsx
// (vite.desktop.config.ts). Identical to upstream except the unit label is
// network-aware: chipnet coins are test coins, so they read "tBCH", not "BCH".
//
// Kept as a swap-copy rather than an edit because the upstream card is
// zero-touch. It's a small presentational component; the only behavioural
// difference from upstream is `unit`.
import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../state/store';
import { FaBitcoin } from 'react-icons/fa';
import { SATSINBITCOIN } from '../../utils/constants';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { Network } from '../../state/slices/networkSlice';

interface Props {
  totalAmount: number; // in satoshis
  quantumrootAmount?: number;
  quantumrootVaultCount?: number;
}

enum DisplayMode {
  BCH = 'BCH',
  USD = 'USD',
}

const DesktopBitcoinCashCard: React.FC<Props> = ({
  totalAmount,
  quantumrootAmount = 0,
  quantumrootVaultCount = 0,
}) => {
  const bchQuote = useSelector(
    (state: RootState) => state.priceFeed['BCH-USD']
  );
  // Chipnet holds test coins — label them tBCH so they can't be mistaken for
  // mainnet value. The toggle button stays "BCH" (the display-mode name).
  const network = useSelector(selectCurrentNetwork);
  const unit = network === Network.MAINNET ? 'BCH' : 'tBCH';

  const [mode, setMode] = useState<DisplayMode>(DisplayMode.USD);

  const totalBch = totalAmount / SATSINBITCOIN;
  const quantumrootBch = quantumrootAmount / SATSINBITCOIN;

  const safeRate = bchQuote?.price ?? 0;
  const totalUsd = (totalBch * safeRate).toFixed(2);

  return (
    <div className="wallet-card p-4 mb-4 flex flex-col w-full max-w-md">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <FaBitcoin className="wallet-accent-icon text-3xl" />
          {mode === DisplayMode.BCH ? (
            <div>
              <div className="text-lg font-bold">${totalUsd} USD</div>
              <div className="text-sm wallet-muted">
                {totalBch.toFixed(8)} {unit}
              </div>
            </div>
          ) : (
            <div>
              <div className="text-lg font-bold">{totalBch.toFixed(8)} {unit}</div>
              <div className="text-sm wallet-muted">${totalUsd} USD</div>
            </div>
          )}
        </div>

        <div className="flex flex-col justify-center mx-4 space-y-2">
          {mode !== DisplayMode.BCH && (
            <button
              onClick={() => setMode(DisplayMode.BCH)}
              className="wallet-btn-primary p-1 px-3"
            >
              {unit}
            </button>
          )}
          {mode !== DisplayMode.USD && (
            <button
              onClick={() => setMode(DisplayMode.USD)}
              className="wallet-btn-secondary p-1 px-3"
            >
              USD
            </button>
          )}
        </div>
      </div>

      {quantumrootAmount > 0 && (
        <div className="mt-3 text-xs wallet-muted">
          Includes {quantumrootBch.toFixed(8)} {unit} across {quantumrootVaultCount}{' '}
          Quantumroot vault{quantumrootVaultCount === 1 ? '' : 's'}.
        </div>
      )}
    </div>
  );
};

export default DesktopBitcoinCashCard;
