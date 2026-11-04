import React from 'react';

type SegmentedSubnavProps<T extends string> = {
  value: T;
  onChange: React.Dispatch<React.SetStateAction<T>>;
  options: Array<{
    value: T;
    label: string;
    icon?: React.ReactNode;
  }>;
  className?: string;
  stretch?: boolean;
  wrap?: boolean;
};

const SegmentedSubnav = <T extends string>({
  value,
  onChange,
  options,
  className = '',
  stretch = false,
  wrap = false,
}: SegmentedSubnavProps<T>) => {
  return (
    <div
      className={`${
        stretch
          ? 'grid grid-cols-2 gap-2'
          : wrap
            ? 'flex flex-wrap gap-2'
            : 'flex gap-2 overflow-x-auto overscroll-contain pb-1'
      } ${className}`.trim()}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`${
            stretch ? 'w-full' : 'shrink-0 whitespace-nowrap'
          } ${option.icon ? 'flex min-w-[4.5rem] flex-col items-center gap-0.5 px-3 py-1.5 text-[10px]' : 'px-3 py-2 text-sm'} rounded-2xl border font-semibold leading-tight transition ${
            value === option.value
              ? 'wallet-segment-active border-[var(--wallet-accent)]'
              : 'wallet-segment-inactive border-[var(--wallet-border)]'
          }`}
        >
          {option.icon ? (
            <span className="text-lg leading-none" aria-hidden="true">
              {option.icon}
            </span>
          ) : null}
          {option.label}
        </button>
      ))}
    </div>
  );
};

export default SegmentedSubnav;
