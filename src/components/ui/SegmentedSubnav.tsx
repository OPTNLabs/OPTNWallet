import React from 'react';

type SegmentedSubnavProps<T extends string> = {
  value: T;
  onChange: React.Dispatch<React.SetStateAction<T>>;
  options: Array<{
    value: T;
    label: string;
  }>;
  className?: string;
  stretch?: boolean;
};

const SegmentedSubnav = <T extends string,>({
  value,
  onChange,
  options,
  className = '',
  stretch = false,
}: SegmentedSubnavProps<T>) => {
  return (
    <div
      className={`${
        stretch ? 'grid grid-cols-2 gap-2' : 'flex gap-2 overflow-x-auto overscroll-contain pb-1'
      } ${className}`.trim()}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`${
            stretch ? 'w-full' : 'shrink-0 whitespace-nowrap'
          } rounded-2xl border px-3 py-2 text-sm font-semibold leading-tight transition ${
            value === option.value
              ? 'wallet-segment-active border-[var(--wallet-accent)]'
              : 'wallet-segment-inactive border-[var(--wallet-border)]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
};

export default SegmentedSubnav;
