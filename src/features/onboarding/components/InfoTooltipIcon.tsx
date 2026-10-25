import { useId, useState } from 'react';
import { MdInfoOutline } from 'react-icons/md';

type InfoTooltipIconProps = {
  id: string;
  content: string;
  className?: string;
  iconClassName?: string;
  ariaLabel?: string;
};

const InfoTooltipIcon = ({
  id,
  content,
  className = 'max-w-[80vw] whitespace-normal break-words text-sm leading-snug font-normal',
  iconClassName = 'cursor-pointer wallet-accent-icon text-lg font-bold select-none',
  ariaLabel = 'More information',
}: InfoTooltipIconProps) => {
  const [open, setOpen] = useState(false);
  const generatedId = useId();
  const contentId = `${id || generatedId}-help`;

  return (
    <span className="relative inline-flex min-h-[44px] min-w-[44px] items-center justify-center">
      <button
        type="button"
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wallet-focus-ring)]"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        <MdInfoOutline aria-hidden="true" className={iconClassName} />
      </button>
      {open ? (
        <span
          id={contentId}
          role="note"
          className={`absolute left-0 top-full z-50 mt-1 rounded-xl border border-[var(--wallet-border)] wallet-surface-strong p-3 shadow-xl ${className}`}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
};

export default InfoTooltipIcon;
