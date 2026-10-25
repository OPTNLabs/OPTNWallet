type ContractLoadFailureProps = {
  message: string;
  retryLabel: string;
  onRetry: () => void;
};

export default function ContractLoadFailure({
  message,
  retryLabel,
  onRetry,
}: ContractLoadFailureProps) {
  return (
    <div className="wallet-card mt-4 p-4 text-center" role="alert">
      <p className="wallet-text-strong">{message}</p>
      <button
        type="button"
        className="wallet-btn-secondary mt-3 min-h-[44px] px-4 py-2"
        onClick={onRetry}
      >
        {retryLabel}
      </button>
    </div>
  );
}
