type ReceiveAddressSetupActionProps = {
  busy: boolean;
  error: boolean;
  label: string;
  loadingLabel: string;
  errorLabel: string;
  onPrepare: () => void;
};

export default function ReceiveAddressSetupAction({
  busy,
  error,
  label,
  loadingLabel,
  errorLabel,
  onPrepare,
}: ReceiveAddressSetupActionProps) {
  return (
    <div className="space-y-3">
      {error && (
        <p className="text-sm wallet-danger-text" role="alert">
          {errorLabel}
        </p>
      )}
      <button
        type="button"
        className="wallet-btn-secondary min-h-[44px] w-full"
        onClick={onPrepare}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? loadingLabel : label}
      </button>
    </div>
  );
}
