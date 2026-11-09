import React, { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/useI18n';

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
  onFinish?: () => void;
};

const WalkthroughPanel: React.FC<WalkthroughPanelProps> = ({
  title,
  description,
  steps,
  className = '',
  numbered = true,
  onFinish,
}) => {
  const { t } = useI18n();
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
  }, [title, steps.length]);

  if (steps.length === 0) return null;

  const currentIndex = Math.min(activeIndex, steps.length - 1);
  const step = steps[currentIndex];
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === steps.length - 1;

  return (
    <section
      className={`wallet-section max-h-[60vh] overflow-y-auto pr-1 ${className}`.trim()}
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="wallet-kicker mb-1">{t('walkthrough.label')}</div>
          <h2 className="text-base font-semibold wallet-text-strong">
            {title}
          </h2>
        </div>
      </div>

      {description ? (
        <p className="mt-2 text-sm wallet-muted">{description}</p>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-3 text-xs wallet-muted">
        <span>
          {t('walkthrough.progress', {
            current: currentIndex + 1,
            total: steps.length,
          })}
        </span>
        <div className="flex gap-1" aria-hidden="true">
          {steps.map((_, index) => (
            <span
              key={index}
              className={`h-1.5 w-5 rounded-full ${
                index === currentIndex
                  ? 'bg-[var(--wallet-accent)]'
                  : 'bg-[var(--wallet-border)]'
              }`}
            />
          ))}
        </div>
      </div>

      <article className="mt-3 min-h-[9rem] rounded-xl border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-surface-strong)_72%,transparent)] p-3">
        <div className="flex items-start gap-3">
          {numbered ? (
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--wallet-accent-soft)] text-sm font-bold text-[var(--wallet-accent-strong)]">
              {currentIndex + 1}
            </div>
          ) : (
            <div className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--wallet-accent)]" />
          )}
          <div>
            <h3 className="font-semibold wallet-text-strong">{step.title}</h3>
            <p className="mt-1 text-sm wallet-muted">{step.description}</p>
          </div>
        </div>
      </article>

      <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <button
          type="button"
          className="wallet-btn-secondary"
          onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}
          disabled={isFirst}
        >
          {t('walkthrough.previous')}
        </button>
        <button
          type="button"
          className="wallet-btn-primary"
          onClick={() => {
            if (isLast) {
              onFinish?.();
              return;
            }
            setActiveIndex((index) => Math.min(steps.length - 1, index + 1));
          }}
        >
          {t(isLast ? 'walkthrough.finish' : 'walkthrough.next')}
        </button>
      </div>
    </section>
  );
};

export default WalkthroughPanel;
