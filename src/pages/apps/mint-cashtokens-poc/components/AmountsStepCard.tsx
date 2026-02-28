import { Badge, CardShell, PillButton, QuickChip } from './uiPrimitives';
import type {
  MintAppUtxo,
  MintConfig,
  MintOutputDraft,
  NftCapability,
} from '../types';
import { shortHash, utxoKey } from '../utils';

type AmountsStepCardProps = {
  selectedUtxos: MintAppUtxo[];
  selectedRecipientCount: number;
  activeOutputDrafts: MintOutputDraft[];
  expandedDraftId: string | null;
  orderedSelectedRecipients: string[];
  onAddOutputDraft: () => void;
  onSetExpandedDraftId: (id: string | null) => void;
  onUpdateOutputDraft: (id: string, patch: Partial<MintOutputDraft>) => void;
  onUpdateOutputDraftConfig: (id: string, patch: Partial<MintConfig>) => void;
  onDuplicateOutputDraft: (id: string) => void;
  onRemoveOutputDraft: (id: string) => void;
};

export default function AmountsStepCard({
  selectedUtxos,
  selectedRecipientCount,
  activeOutputDrafts,
  expandedDraftId,
  orderedSelectedRecipients,
  onAddOutputDraft,
  onSetExpandedDraftId,
  onUpdateOutputDraft,
  onUpdateOutputDraftConfig,
  onDuplicateOutputDraft,
  onRemoveOutputDraft,
}: AmountsStepCardProps) {
  return (
    <CardShell
      title="Amounts"
      right={
        activeOutputDrafts.length > 0 ? (
          <Badge tone="green">{`${activeOutputDrafts.length} output${
            activeOutputDrafts.length === 1 ? '' : 's'
          }`}</Badge>
        ) : (
          <Badge tone="gray">—</Badge>
        )
      }
      open={true}
      collapsible={false}
      onToggle={() => {}}
    >
      {selectedUtxos.length === 0 ? (
        <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-4 text-[12px] wallet-muted">
          Select at least one source to configure mint amounts.
        </div>
      ) : selectedRecipientCount === 0 ? (
        <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-4 text-[12px] wallet-muted">
          Select at least one recipient to configure per-recipient allocations.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onAddOutputDraft}
              className="wallet-btn-primary px-3 py-2 text-sm font-semibold"
            >
              + Add output
            </button>
          </div>

          {activeOutputDrafts.length === 0 ? (
            <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-4 text-[12px] wallet-muted">
              No outputs configured yet. Add an output mapping.
            </div>
          ) : null}

          {activeOutputDrafts.map((d, idx) => {
            const source = selectedUtxos.find(
              (u) => utxoKey(u) === d.sourceKey
            );
            if (!source) return null;
            const open = expandedDraftId === d.id;
            const collapsedLabel =
              d.config.mintType === 'NFT'
                ? `NFT • ${d.config.nftCapability}`
                : `FT • ${d.config.ftAmount || '0'}`;

            return (
              <div
                key={d.id}
                className="rounded-[16px] wallet-card shadow-[0_1px_0_rgba(0,0,0,0.08)] overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => onSetExpandedDraftId(open ? null : d.id)}
                  className="w-full px-5 py-4 flex items-center justify-between"
                >
                  <div className="min-w-0 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">
                        Output {idx + 1}
                      </span>
                      <Badge
                        tone={d.config.mintType === 'NFT' ? 'blue' : 'green'}
                      >
                        {d.config.mintType}
                      </Badge>
                    </div>
                    <div className="mt-1 text-[12px] wallet-muted font-mono truncate">
                      {shortHash(d.recipientCashAddr, 14, 10)} ←{' '}
                      {shortHash(source.tx_hash, 12, 8)} • {collapsedLabel}
                    </div>
                  </div>
                  <div className="wallet-muted font-bold text-lg">
                    {open ? '−' : '+'}
                  </div>
                </button>
                {open ? <div className="h-px wallet-surface-strong" /> : null}

                {open ? (
                  <div className="px-5 pb-5 pt-4 space-y-4">
                    <div className="grid grid-cols-1 gap-3">
                      <div>
                        <label className="block text-sm font-semibold mb-1">
                          Recipient
                        </label>
                        <select
                          value={d.recipientCashAddr}
                          onChange={(e) =>
                            onUpdateOutputDraft(d.id, {
                              recipientCashAddr: e.target.value,
                            })
                          }
                          className="wallet-input p-3 w-full rounded-xl"
                        >
                          {orderedSelectedRecipients.map((addr) => (
                            <option key={addr} value={addr}>
                              {addr}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-semibold mb-1">
                          Candidate UTXO
                        </label>
                        <select
                          value={d.sourceKey}
                          onChange={(e) =>
                            onUpdateOutputDraft(d.id, {
                              sourceKey: e.target.value,
                            })
                          }
                          className="wallet-input p-3 w-full rounded-xl"
                        >
                          {selectedUtxos.map((u) => {
                            const key = utxoKey(u);
                            return (
                              <option key={key} value={key}>
                                {key}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <PillButton
                        active={d.config.mintType === 'FT'}
                        onClick={() =>
                          onUpdateOutputDraftConfig(d.id, {
                            mintType: 'FT',
                          })
                        }
                      >
                        FT
                      </PillButton>
                      <PillButton
                        active={d.config.mintType === 'NFT'}
                        onClick={() =>
                          onUpdateOutputDraftConfig(d.id, {
                            mintType: 'NFT',
                          })
                        }
                      >
                        NFT
                      </PillButton>
                    </div>

                    {d.config.mintType === 'FT' ? (
                      <div className="space-y-2">
                        <label className="block text-sm font-semibold">
                          FT amount
                        </label>
                        <input
                          type="number"
                          min="1"
                          value={d.config.ftAmount}
                          onChange={(e) =>
                            onUpdateOutputDraftConfig(d.id, {
                              ftAmount: e.target.value,
                            })
                          }
                          className="wallet-input wallet-surface-strong p-4 w-full rounded-[16px] text-2xl font-semibold tracking-tight"
                        />
                        <div className="flex flex-wrap gap-2">
                          <QuickChip
                            label="1"
                            onClick={() =>
                              onUpdateOutputDraftConfig(d.id, { ftAmount: '1' })
                            }
                          />
                          <QuickChip
                            label="10"
                            onClick={() =>
                              onUpdateOutputDraftConfig(d.id, {
                                ftAmount: '10',
                              })
                            }
                          />
                          <QuickChip
                            label="100"
                            onClick={() =>
                              onUpdateOutputDraftConfig(d.id, {
                                ftAmount: '100',
                              })
                            }
                          />
                          <QuickChip
                            label="1k"
                            onClick={() =>
                              onUpdateOutputDraftConfig(d.id, {
                                ftAmount: '1000',
                              })
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <label className="block text-sm font-semibold">
                          NFT capability
                        </label>
                        <select
                          value={d.config.nftCapability}
                          onChange={(e) =>
                            onUpdateOutputDraftConfig(d.id, {
                              nftCapability: e.target.value as NftCapability,
                            })
                          }
                          className="wallet-input p-3 w-full rounded-xl"
                        >
                          <option value="none">none</option>
                          <option value="mutable">mutable</option>
                          <option value="minting">minting</option>
                        </select>

                        <details className="rounded-xl wallet-surface-strong border border-[var(--wallet-border)] p-3">
                          <summary className="text-sm font-semibold cursor-pointer">
                            Advanced
                          </summary>
                          <div className="mt-3 space-y-2">
                            <label className="block text-sm font-semibold">
                              NFT commitment (optional)
                            </label>
                            <input
                              type="text"
                              value={d.config.nftCommitment}
                              onChange={(e) =>
                                onUpdateOutputDraftConfig(d.id, {
                                  nftCommitment: e.target.value,
                                })
                              }
                              className="wallet-input p-3 w-full rounded-xl"
                              placeholder="hex or text (passed through as-is)"
                            />
                          </div>
                        </details>
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onDuplicateOutputDraft(d.id)}
                        className="wallet-btn-secondary px-3 py-2 text-sm font-semibold"
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveOutputDraft(d.id)}
                        className="wallet-btn-danger px-3 py-2 text-sm font-semibold"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </CardShell>
  );
}
