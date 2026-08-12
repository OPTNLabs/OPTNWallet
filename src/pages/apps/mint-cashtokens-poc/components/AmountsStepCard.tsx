import { memo, useMemo } from 'react';
import { Badge, CardShell } from './uiPrimitives';
import type { MintAppUtxo, MintOutputDraft } from '../types';
import { shortHash, utxoKey } from '../utils';
import { getMintSourceCategory } from '../utils/sourceHelpers';

type AmountsStepCardProps = {
  selectedUtxos: MintAppUtxo[];
  selectedRecipientCount: number;
  outputDrafts: MintOutputDraft[];
  onOpenAddOutputDraftForm: () => void;
  onOpenEditOutputDraftForm: (draft: MintOutputDraft) => void;
};

function AmountsStepCardImpl({
  selectedUtxos,
  selectedRecipientCount,
  outputDrafts,
  onOpenAddOutputDraftForm,
  onOpenEditOutputDraftForm,
}: AmountsStepCardProps) {
  const selectedSourceByKey = useMemo(() => {
    const out = new Map<string, MintAppUtxo>();
    for (const u of selectedUtxos) out.set(utxoKey(u), u);
    return out;
  }, [selectedUtxos]);

  const describeCapability = (capability: 'none' | 'mutable' | 'minting') => {
    switch (capability) {
      case 'mutable':
        return 'mutable authority';
      case 'minting':
        return 'minting authority';
      default:
        return 'plain NFT';
    }
  };

  return (
    <CardShell
      title="Amounts"
      right={
        outputDrafts.length > 0 ? (
          <Badge tone="green">{`${outputDrafts.length} output${
            outputDrafts.length === 1 ? '' : 's'
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
              onClick={onOpenAddOutputDraftForm}
              className="wallet-btn-primary px-3 py-2 text-sm font-semibold"
            >
              + Add output
            </button>
          </div>

          {outputDrafts.length === 0 ? (
            <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-4 text-[12px] wallet-muted">
              No outputs configured yet. Add an output mapping.
            </div>
          ) : null}

          {outputDrafts.map((d, idx) => {
            const source = selectedSourceByKey.get(d.sourceKey);
            if (!source) return null;
            const sourceCategory = getMintSourceCategory(source);
            const collapsedLabel =
              d.config.mintType === 'NFT'
                ? `NFT • ${describeCapability(d.config.nftCapability)}`
                : `FT • ${d.config.ftAmount || '0'}`;

            return (
              <div
                key={d.id}
                className="rounded-[16px] wallet-card shadow-[0_1px_0_rgba(0,0,0,0.08)] overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => onOpenEditOutputDraftForm(d)}
                  className="w-full px-5 py-4 flex items-center justify-between text-left"
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
                      {shortHash(sourceCategory, 12, 8)} • {collapsedLabel}
                    </div>
                  </div>
                  <div className="wallet-muted font-bold text-lg">+</div>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </CardShell>
  );
}

const AmountsStepCard = memo(AmountsStepCardImpl);

export default AmountsStepCard;
