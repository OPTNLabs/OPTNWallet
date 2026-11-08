// What a watch-only (SeedCash) send pays: BCH, or one of the wallet's tokens.
//
// Presentation only. It turns the holder's choice into a TokenPayment; which
// coins that spends, where every token goes and whether anything would be
// burned are decided in Rust when the send is planned.
import { assetKey, formatTokenUnits, type TokenAsset } from './tokenAssets';

type Props = {
  assets: readonly TokenAsset[];
  /** Null: the send pays BCH. */
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  amountText: string;
  onAmountChange: (text: string) => void;
  sendAll: boolean;
  onSendAllChange: (sendAll: boolean) => void;
  disabled?: boolean;
};

export function TokenSendPanel({
  assets,
  selectedKey,
  onSelect,
  amountText,
  onAmountChange,
  sendAll,
  onSendAllChange,
  disabled = false,
}: Props) {
  const selected = assets.find((asset) => assetKey(asset) === selectedKey);
  return (
    <div className="space-y-2" data-testid="watch-only-token-send">
      <label className="block space-y-1 text-sm wallet-text-strong">
        What to send
        <select
          value={selectedKey ?? ''}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.value || null)}
          className="wallet-input w-full"
          data-testid="watch-only-asset"
        >
          <option value="">BCH</option>
          {assets.map((asset) => (
            <option key={assetKey(asset)} value={assetKey(asset)}>
              {asset.kind === 'fungible'
                ? `${asset.title} (${formatTokenUnits(asset.total, asset.decimals)} available) · ${asset.categoryShort}`
                : `NFT ${asset.title} · ${asset.capability} · ${asset.categoryShort}`}
            </option>
          ))}
        </select>
      </label>
      {selected?.kind === 'fungible' && (
        <div className="space-y-1">
          <label className="block space-y-1 text-sm wallet-text-strong">
            Amount ({selected.title})
            <input
              value={sendAll ? '' : amountText}
              disabled={disabled || sendAll}
              onChange={(event) => onAmountChange(event.target.value)}
              inputMode="decimal"
              placeholder={
                sendAll
                  ? 'Every unit of this token'
                  : `Up to ${selected.decimals} decimals`
              }
              className="wallet-input w-full"
              data-testid="watch-only-token-amount"
            />
          </label>
          <label className="flex items-center gap-2 text-xs wallet-text-strong">
            <input
              type="checkbox"
              checked={sendAll}
              disabled={disabled}
              onChange={(event) => onSendAllChange(event.target.checked)}
              className="accent-[var(--wallet-accent)]"
              data-testid="watch-only-token-send-all"
            />
            Send all {selected.title}
          </label>
        </div>
      )}
      {selected?.kind === 'nft' && (
        <p className="text-xs wallet-muted">
          The NFT moves exactly as it is: same category, capability and
          commitment ({selected.commitment || 'none'}).
        </p>
      )}
      {selected && (
        <p className="text-xs wallet-muted">
          Send tokens to a token-aware address (bitcoincash:z… or bchtest:z…).
          Other tokens on the coins this send spends come back to this wallet.
        </p>
      )}
    </div>
  );
}

export default TokenSendPanel;
