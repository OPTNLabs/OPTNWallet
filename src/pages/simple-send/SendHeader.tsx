import React from 'react';
import { Link } from 'react-router-dom';

type SendHeaderProps = {
  showDebug: boolean;
  setShowDebug: React.Dispatch<React.SetStateAction<boolean>>;
};

export function SendHeader({ showDebug, setShowDebug }: SendHeaderProps) {
  return (
    <>
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="w-3/4 h-auto"
        />
      </div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-extrabold wallet-text-strong">
          Simple Send
        </h1>
        <div className="flex items-center gap-3">
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
            Advanced mode
          </Link>
        </div>
      </div>
    </>
  );
}
