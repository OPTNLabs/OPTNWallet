type PaperWalletSweepErrorProps = {
  message: string;
  compact?: boolean;
};

export default function PaperWalletSweepError({
  message,
  compact = false,
}: PaperWalletSweepErrorProps) {
  return (
    <p
      className={compact ? 'wallet-danger-text' : 'mt-3 wallet-danger-text'}
      role="alert"
    >
      {message}
    </p>
  );
}
