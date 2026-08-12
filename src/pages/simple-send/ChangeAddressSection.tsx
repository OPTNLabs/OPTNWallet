type ChangeAddressSectionProps = {
  selectedChangeAddress: string;
  setSelectedChangeAddress: (address: string) => void;
  selectClass: string;
  addresses: { address: string; tokenAddress: string }[];
  mask: (value: string) => string;
};

export function ChangeAddressSection({
  selectedChangeAddress,
  setSelectedChangeAddress,
  selectClass,
  addresses,
  mask,
}: ChangeAddressSectionProps) {
  return (
    <div className="rounded-2xl border border-[var(--wallet-border)] wallet-surface-strong px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <label className="text-sm font-semibold wallet-text-strong">
          Change address
        </label>
        <span className="text-[11px] wallet-muted font-mono">
          {selectedChangeAddress ? mask(selectedChangeAddress) : 'Loading...'}
        </span>
      </div>
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

      {/* <div className="text-[11px] wallet-muted mt-1">
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
      </div> */}
    </div>
  );
}
