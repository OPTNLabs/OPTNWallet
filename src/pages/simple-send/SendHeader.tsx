import React from 'react';
import { Link } from 'react-router-dom';

type SendHeaderProps = {
  showDebug: boolean;
  setShowDebug: React.Dispatch<React.SetStateAction<boolean>>;
};

export function SendHeader({ showDebug, setShowDebug }: SendHeaderProps) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] wallet-muted">
          OPTN Wallet
        </div>
        <h1 className="text-2xl font-extrabold wallet-text-strong leading-tight">
          Simple Send
        </h1>
        <p className="text-sm wallet-muted">
          Send BCH, fungible tokens, or NFTs with one guided flow.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <label className="flex items-center gap-2 text-xs font-semibold wallet-muted select-none">
          <input
            type="checkbox"
            className="w-4 h-4"
            style={{ accentColor: 'var(--wallet-accent-strong)' }}
            checked={showDebug}
            onChange={(e) => setShowDebug(e.target.checked)}
          />
          Debug
        </label>

        <Link
          to="/transaction"
          className="text-sm font-semibold wallet-text-strong underline underline-offset-4"
          title="Open Advanced Builder"
        >
          Advanced
        </Link>
      </div>
    </div>
  );
}
