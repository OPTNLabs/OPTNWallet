// The ways into a wallet, shown as one list on every platform.
//
// Before this, the browser and mobile builds rendered a landing page with two
// buttons and the desktop build rendered a different one with four. Nothing on
// screen said so, so a user on the wrong build could not tell whether watch-only
// existed, was unsupported, or was somewhere they had not looked — which is
// exactly what happened when SeedCash tried to test the PSBT flow from a dev
// server and reported the options as missing.
//
// Showing an option as unavailable, with the reason, is more useful than hiding
// it: it answers the question instead of raising it.
import type { FC, ReactNode } from 'react';
import { Link } from 'react-router-dom';

export type WalletSetupOption = {
  id: string;
  label: string;
  description: string;
  /** Where it goes when available. Omitted for options that are not yet usable. */
  to?: string;
  /** Called instead of navigating, for flows that open in place. */
  onSelect?: () => void;
  /** Shown instead of the action when set, e.g. "Desktop only". */
  unavailableReason?: string;
  /** The one option a first-time user most likely wants. */
  primary?: boolean;
  icon?: ReactNode;
};

const baseClasses =
  'flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors';

const Chip: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="mt-1 inline-block rounded-full border border-[var(--wallet-border)] px-2 py-0.5 text-[11px] font-semibold wallet-muted">
    {children}
  </span>
);

const OptionBody: FC<{ option: WalletSetupOption }> = ({ option }) => (
  <>
    {option.icon ? (
      <span className="mt-0.5 shrink-0 text-lg wallet-muted" aria-hidden="true">
        {option.icon}
      </span>
    ) : null}
    <span className="flex min-w-0 flex-col">
      <span className="font-semibold wallet-text-strong">{option.label}</span>
      <span className="mt-0.5 text-sm wallet-muted">{option.description}</span>
      {option.unavailableReason ? <Chip>{option.unavailableReason}</Chip> : null}
    </span>
  </>
);

/**
 * One option per row: available ones are actionable, unavailable ones are
 * visibly inert and say why.
 *
 * Unavailable rows are rendered as disabled buttons rather than as styled divs
 * so a screen reader announces them as controls that cannot be used, and
 * `aria-describedby` carries the reason with them. Colour is never the only
 * signal — the reason is always spelled out.
 */
export const WalletSetupOptions: FC<{ options: WalletSetupOption[] }> = ({
  options,
}) => (
  <ul className="flex w-full flex-col gap-3">
    {options.map((option) => {
      const reasonId = `${option.id}-reason`;
      if (option.unavailableReason) {
        return (
          <li key={option.id}>
            <button
              type="button"
              disabled
              aria-describedby={reasonId}
              className={`${baseClasses} cursor-not-allowed border-[var(--wallet-border)] opacity-60`}
            >
              <OptionBody option={option} />
            </button>
            <span id={reasonId} className="sr-only">
              {option.unavailableReason}
            </span>
          </li>
        );
      }

      const className = `${baseClasses} ${
        option.primary
          ? 'border-[var(--wallet-accent)] wallet-surface-strong'
          : 'border-[var(--wallet-border)] wallet-surface'
      }`;

      return (
        <li key={option.id}>
          {option.to ? (
            <Link to={option.to} className={className}>
              <OptionBody option={option} />
            </Link>
          ) : (
            <button type="button" onClick={option.onSelect} className={className}>
              <OptionBody option={option} />
            </button>
          )}
        </li>
      );
    })}
  </ul>
);

export default WalletSetupOptions;
