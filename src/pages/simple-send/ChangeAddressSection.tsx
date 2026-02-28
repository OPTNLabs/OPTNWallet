import { copyTextToClipboard } from './utils';

type ChangeAddressSectionProps = {
  selectedChangeAddress: string;
  setSelectedChangeAddress: (address: string) => void;
  selectClass: string;
  addresses: { address: string; tokenAddress: string }[];
  mask: (value: string) => string;
  tokenChangeAddress: string;
};

export function ChangeAddressSection({
  selectedChangeAddress,
  setSelectedChangeAddress,
  selectClass,
  addresses,
  mask,
  tokenChangeAddress,
}: ChangeAddressSectionProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-semibold wallet-text-strong">
        Change address
      </label>
      <div className="relative">
        <select
          value={selectedChangeAddress}
          onChange={(e) => setSelectedChangeAddress(e.target.value)}
          className={selectClass}
        >
          {!addresses.length && (
            <option value="" disabled>
              Loading…
            </option>
          )}
          {addresses.map((addressRow) => (
            <option key={addressRow.address} value={addressRow.address}>
              {mask(addressRow.address)}
            </option>
          ))}
        </select>
        <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 wallet-muted">
          ▼
        </div>
      </div>

      <div className="text-[11px] wallet-muted mt-1">
        Token change will go to:{' '}
        <span className="font-mono">
          {mask(tokenChangeAddress || selectedChangeAddress)}
        </span>
        <button
          className="ml-2 wallet-link underline"
          onClick={() =>
            copyTextToClipboard(tokenChangeAddress || selectedChangeAddress)
          }
        >
          Copy
        </button>
      </div>

      <div className="text-xs wallet-muted">
        Using BCH change:{' '}
        <span className="font-mono">{mask(selectedChangeAddress)}</span>
        <button
          className="ml-2 wallet-link underline"
          onClick={() => copyTextToClipboard(selectedChangeAddress)}
        >
          Copy
        </button>
      </div>
    </div>
  );
}
