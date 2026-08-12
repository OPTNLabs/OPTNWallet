import { memo } from 'react';
import { Badge, CardShell } from './uiPrimitives';
import type { WalletAddressRecord } from '../types';
import { shortHash } from '../utils';

type RecipientsStepCardProps = {
  addresses: WalletAddressRecord[];
  selectedRecipientCashAddrs: ReadonlySet<string>;
  recipientTokenAddressByCash: Record<string, string>;
  selectedRecipientCount: number;
  onToggleRecipient: (cashAddr: string) => void;
  onCopyAddress: (address: string) => void;
};

function RecipientsStepCard({
  addresses,
  selectedRecipientCashAddrs,
  recipientTokenAddressByCash,
  selectedRecipientCount,
  onToggleRecipient,
  onCopyAddress,
}: RecipientsStepCardProps) {
  return (
    <CardShell
      title="Recipients"
      subtitle=""
      right={
        <Badge tone={selectedRecipientCount > 0 ? 'green' : 'gray'}>
          {selectedRecipientCount} selected
        </Badge>
      }
      open={true}
      collapsible={false}
      onToggle={() => {}}
    >
      <div className="space-y-3">
        <div className="rounded-[16px] wallet-card shadow-[0_1px_0_rgba(0,0,0,0.08)] overflow-hidden max-h-[280px] overflow-y-auto">
          {addresses.map((a) => {
            const checked = selectedRecipientCashAddrs.has(a.address);
            const tokenAddr = recipientTokenAddressByCash[a.address] || '';
            return (
              <div
                key={a.address}
                className={`px-4 py-4 border-b border-[var(--wallet-border)] last:border-b-0 ${
                  checked ? 'wallet-selectable-active' : 'wallet-selectable-inactive'
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleRecipient(a.address)}
                    className="mt-1 scale-110"
                  />

                  <div className="min-w-0 flex-1">
                    <div className="w-full text-left">
                      <div className="inline-flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold truncate">
                          {shortHash(a.address, 14, 10)}
                        </span>
                        {checked ? (
                          <Badge tone="green">included</Badge>
                        ) : (
                          <Badge>excluded</Badge>
                        )}
                      </div>
                      <div className="mt-1 text-[12px] wallet-muted font-mono truncate">
                        token: {shortHash(tokenAddr, 18, 8)}
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="text-sm font-semibold text-blue-700 shrink-0"
                    onClick={() => onCopyAddress(a.address)}
                  >
                    Copy
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </CardShell>
  );
}

export default memo(RecipientsStepCard);
