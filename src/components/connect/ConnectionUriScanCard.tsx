import { FaCamera } from 'react-icons/fa';

type ConnectionUriScanCardProps = {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onScan: () => void;
  onConnect: () => void;
  scanning?: boolean;
  submitting?: boolean;
  connectLabel?: string;
};

export default function ConnectionUriScanCard({
  label,
  placeholder,
  value,
  onChange,
  onScan,
  onConnect,
  scanning = false,
  submitting = false,
  connectLabel = 'Connect',
}: ConnectionUriScanCardProps) {
  return (
    <div className="wallet-card p-4 space-y-3">
      <label className="font-bold">{label}</label>
      <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
        <input
          className="wallet-input min-w-0"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          onClick={onScan}
          className="inline-flex h-12 w-12 items-center justify-center rounded-[14px] wallet-btn-primary p-0"
          disabled={scanning || submitting}
          aria-label="Scan QR"
          title="Scan QR"
        >
          <FaCamera className="text-base" />
        </button>
      </div>
      <button
        onClick={onConnect}
        className="wallet-btn-primary w-full"
        disabled={submitting}
      >
        {scanning ? 'Scanning...' : connectLabel}
      </button>
    </div>
  );
}
