import { memo } from 'react';
import { Badge, CardShell } from './uiPrimitives';
import type { MintDisplayUtxo } from '../types';
import { shortHash, utxoKey, utxoValue } from '../utils';
import {
  getMintSourceCategory,
  getMintSourceKind,
} from '../utils/sourceHelpers';

type SourcesStepCardProps = {
  displaySourceUtxos: MintDisplayUtxo[];
  selectedKeys: ReadonlySet<string>;
  selectedCount: number;
  pendingCount: number;
  loading: boolean;
  canCreateSource: boolean;
  showCreateSourceAction: boolean;
  onStartBootstrapFlow: () => void;
  onToggleSelect: (u: MintDisplayUtxo) => void;
  onCopyCategory: (category: string) => void;
  onJumpToAmounts: () => void;
};

function SourcesStepCardImpl({
  displaySourceUtxos,
  selectedKeys,
  selectedCount,
  pendingCount,
  loading,
  canCreateSource,
  showCreateSourceAction,
  onStartBootstrapFlow,
  onToggleSelect,
  onCopyCategory,
  onJumpToAmounts,
}: SourcesStepCardProps) {
  const sourcesEmpty = displaySourceUtxos.length === 0;

  const describeSource = (u: MintDisplayUtxo): string => {
    const kind = getMintSourceKind(u);
    switch (kind) {
      case 'minting-nft':
        return 'minting authority';
      case 'genesis':
        return 'genesis source';
      default:
        return 'unsupported source';
    }
  };

  return (
    <CardShell
      title="Source UTXOs"
      subtitle="Pick a genesis UTXO to create a category, or a minting NFT authority to mint additional CashTokens."
      right={
        <div className="flex items-center gap-2">
          <Badge>{`Sources: ${displaySourceUtxos.length}`}</Badge>
          <Badge
            tone={selectedCount > 0 ? 'green' : 'gray'}
          >{`Selected: ${selectedCount}`}</Badge>
          {pendingCount > 0 ? (
            <Badge tone="blue">{`Pending: ${pendingCount}`}</Badge>
          ) : null}
        </div>
      }
      open={true}
      collapsible={false}
      onToggle={() => {}}
    >
      <div className="space-y-4">
        {sourcesEmpty ? (
          <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-5 space-y-3">
            <div className="text-base font-semibold wallet-text-strong">
              No mint sources yet
            </div>
            <div className="text-sm wallet-muted">
              Create a genesis source to start a category, then mint additional
              NFTs from a minting authority NFT.
            </div>

            <button
              onClick={onStartBootstrapFlow}
              disabled={loading || !canCreateSource}
              className="w-full px-4 py-3 rounded-xl bg-emerald-600 text-white font-semibold text-base"
            >
              {loading ? 'Preparing…' : 'Create category source'}
            </button>
          </div>
        ) : (
          <>
            {showCreateSourceAction ? (
              <button
                onClick={onStartBootstrapFlow}
                disabled={loading || !canCreateSource}
                className="w-full px-4 py-3 rounded-xl bg-emerald-600 text-white font-semibold text-base"
              >
                {loading ? 'Preparing…' : 'Create category source'}
              </button>
            ) : null}

            <div className="rounded-[16px] wallet-card shadow-[0_1px_0_rgba(0,0,0,0.08)] overflow-hidden">
              {displaySourceUtxos.map((u) => {
                const key = utxoKey(u);
                const checked = selectedKeys.has(key);
                const value = utxoValue(u);
                const isBootstrap = u.__synthetic === 'bootstrap';
                const category = getMintSourceCategory(u);
                const kind = getMintSourceKind(u);

                return (
                  <div
                    key={key}
                    className={`px-4 py-4 border-b border-[var(--wallet-border)] last:border-b-0 flex items-center gap-3 ${
                      checked
                        ? 'wallet-selectable-active'
                        : 'wallet-selectable-inactive'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleSelect(u)}
                      className="scale-110"
                    />
                    <button
                      type="button"
                      onClick={() => onCopyCategory(category)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center px-3 py-1.5 rounded-full wallet-surface-strong wallet-text-strong text-[13px] font-semibold font-mono truncate">
                          {shortHash(category, 12, 8)}
                        </span>
                        <Badge tone={kind === 'genesis' ? 'green' : 'blue'}>
                          {describeSource(u)}
                        </Badge>
                        {isBootstrap ? <Badge tone="amber">bootstrap</Badge> : null}
                      </div>
                      <div className="text-[12px] wallet-muted mt-1">
                        {value.toString()} sats • vout {u.tx_pos}
                      </div>
                    </button>

                    {checked ? (
                      <button
                        type="button"
                        onClick={() => {
                          onToggleSelect(u);
                          onJumpToAmounts();
                        }}
                        className="text-[13px] font-semibold wallet-text-strong"
                      >
                        Edit
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </CardShell>
  );
}

const SourcesStepCard = memo(SourcesStepCardImpl);

export default SourcesStepCard;
