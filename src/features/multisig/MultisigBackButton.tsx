import type { ButtonHTMLAttributes, ReactNode } from 'react';

type MultisigBackButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type'
> & {
  children?: ReactNode;
};

/** The shared red navigation treatment used by the wallet's Back buttons. */
export default function MultisigBackButton({
  children = 'Back',
  className = '',
  ...props
}: MultisigBackButtonProps) {
  return (
    <button
      {...props}
      type="button"
      className={`wallet-btn-danger px-4 py-2 ${className}`.trim()}
    >
      {children}
    </button>
  );
}
