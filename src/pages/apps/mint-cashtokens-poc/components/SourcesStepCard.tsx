import { Badge, CardShell } from './uiPrimitives';
import type { MintDisplayUtxo } from '../types';
import { shortHash, utxoKey, utxoValue } from '../utils';

type SourcesStepCardProps = {
  displayGenesisUtxos: MintDisplayUtxo[];
  selectedKeys: ReadonlySet<string>;
  selectedCount: number;
  pendingCount: number;
  loading: boolean;
  canCreateSource: boolean;
  onStartBootstrapFlow: () => void;
  onToggleSelect: (u: MintDisplayUtxo) => void;
  onCopyCategory: (categoryTxid: string) => void;
  onJumpToAmounts: () => void;
};

export default function SourcesStepCard({
  displayGenesisUtxos,
  selectedKeys,
  selectedCount,
  pendingCount,
  loading,
  canCreateSource,
  onStartBootstrapFlow,
  onToggleSelect,
  onCopyCategory,
  onJumpToAmounts,
}: SourcesStepCardProps) {
  const sourcesEmpty = displayGenesisUtxos.length === 0;

  return (
    <CardShell
      title="Candidate UTXO"
      subtitle=""
      right={
        <div className="flex items-center gap-2">
          <Badge>{`UTXOs: ${displayGenesisUtxos.length}`}</Badge>
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
              No Candidate UTXOs yet
            </div>
            <div className="text-sm wallet-muted">
              Create one to define a token category.
            </div>

            <button
              onClick={onStartBootstrapFlow}
              disabled={loading || !canCreateSource}
              className="w-full px-4 py-3 rounded-xl bg-emerald-600 text-white font-semibold text-base"
            >
              {loading ? 'Preparing…' : 'Create Candidate UTXO'}
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={onStartBootstrapFlow}
              disabled={loading || !canCreateSource}
              className="w-full px-4 py-3 rounded-xl bg-emerald-600 text-white font-semibold text-base"
            >
              {loading ? 'Preparing…' : 'Create Candidate UTXO'}
            </button>

            <div className="rounded-[16px] wallet-card shadow-[0_1px_0_rgba(0,0,0,0.08)] overflow-hidden">
              {displayGenesisUtxos.map((u) => {
                const key = utxoKey(u);
                const checked = selectedKeys.has(key);
                const value = utxoValue(u);
                const isBootstrap = u.__synthetic === 'bootstrap';

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
                      onClick={() => onCopyCategory(u.tx_hash)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center px-3 py-1.5 rounded-full wallet-surface-strong wallet-text-strong text-[13px] font-semibold font-mono truncate">
                          {shortHash(u.tx_hash, 12, 8)}
                        </span>
                        {isBootstrap ? (
                          <Badge tone="blue">bootstrap</Badge>
                        ) : null}
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
