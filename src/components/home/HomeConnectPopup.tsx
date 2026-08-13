import ConnectionUriScanCard from '../connect/ConnectionUriScanCard';

type HomeConnectPopupProps = {
  uri: string;
  onChange: (value: string) => void;
  onScan: () => void;
  onConnect: () => void;
  onClose: () => void;
  scanning?: boolean;
  submitting?: boolean;
};

export default function HomeConnectPopup({
  uri,
  onChange,
  onScan,
  onConnect,
  onClose,
  scanning = false,
  submitting = false,
}: HomeConnectPopupProps) {
  return (
    <div className="wallet-popup-backdrop p-3 sm:p-4">
      <div className="wallet-popup-panel max-w-md w-full space-y-4">
        <div className="space-y-1 text-center">
          <h2 className="text-xl font-bold">Connect</h2>
          <p className="text-sm wallet-muted">
            Paste or scan a CashConnect invite, WalletConnect URI, or payment
            address. Approve requests stay on Home.
          </p>
        </div>
        <ConnectionUriScanCard
          label="URI"
          placeholder="bch-cc-v1:… or wc:…"
          value={uri}
          onChange={onChange}
          onScan={onScan}
          onConnect={onConnect}
          scanning={scanning}
          submitting={submitting}
        />
        <button
          type="button"
          className="wallet-btn-secondary w-full"
          onClick={onClose}
          disabled={scanning || submitting}
        >
          Close
        </button>
      </div>
    </div>
  );
}
