import React from 'react';

type WalkthroughStep = {
  title: string;
  description: string;
};

type WalkthroughPanelProps = {
  title: string;
  description?: string;
  steps: WalkthroughStep[];
  className?: string;
  numbered?: boolean;
};

const WalkthroughPanel: React.FC<WalkthroughPanelProps> = ({
  title,
  description,
  steps,
  className = '',
  numbered = true,
}) => {
  return (
    <section
      className={`wallet-section max-h-[60vh] overflow-y-auto pr-1 ${className}`.trim()}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="wallet-kicker mb-1">Walkthrough</div>
          <h2 className="text-base font-semibold wallet-text-strong">{title}</h2>
        </div>
      </div>

      {description ? (
        <p className="mt-2 text-sm wallet-muted">{description}</p>
      ) : null}

      <ol className="mt-3 space-y-3">
        {steps.map((step, index) => (
          <li
            key={`${step.title}-${index}`}
            className="rounded-xl border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-surface-strong)_72%,transparent)] p-3"
          >
            <div className="flex items-start gap-3">
              {numbered ? (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--wallet-accent-soft)] text-sm font-bold text-[var(--wallet-accent-strong)]">
                  {index + 1}
                </div>
              ) : (
                <div className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--wallet-accent)]" />
              )}
              <div>
                <div className="font-semibold wallet-text-strong">{step.title}</div>
                <div className="mt-1 text-sm wallet-muted">{step.description}</div>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
};

export default WalkthroughPanel;
