import React from 'react';
import { useSelector } from 'react-redux';
import type { RelayConnectionState } from '@wizardconnect/wallet';
import type { RootState } from '../../state/store';
import WizardDappAvatar from './WizardDappAvatar';

interface Props {
  connectionId: string;
  onDisconnect: (connectionId: string) => void;
  onClose: () => void;
}

const WizardConnectionSettingsModal: React.FC<Props> = ({
  connectionId,
  onDisconnect,
  onClose,
}) => {
  const connection = useSelector(
    (state: RootState) => state.wizardconnect.activeConnections[connectionId]
  );

  if (!connection) return null;

  const view = connection as RelayConnectionState & {
    dappDescription?: string | null;
  };
  const title = connection.dappName ?? connection.label ?? 'WizardConnect';
  const description = view.dappDescription?.trim();
  const connectedAtMs =
    connection.connectedAt > 1_000_000_000_000
      ? connection.connectedAt
      : connection.connectedAt * 1000;
  const connectedAt = new Date(connectedAtMs).toLocaleString();

  return (
    <div className="wallet-popup-backdrop">
      <div className="wallet-popup-panel max-w-md w-full">
        <div className="flex items-center gap-4 mb-4 min-w-0">
          <WizardDappAvatar
            name={connection.dappName ?? connection.label}
            iconUrl={connection.dappIcon}
            className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full wallet-surface-strong border border-[var(--wallet-border)] bg-[var(--wallet-surface)]"
          />
          <div className="flex min-w-0 flex-col text-center">
            <p className="font-bold text-lg sm:text-xl leading-tight break-words">
              {title}
            </p>
            <span className="wallet-muted text-xs sm:text-sm">
              {connection.status.status}
            </span>
            <div className="mt-1 text-xs sm:text-sm leading-relaxed break-words">
              {description ? (
                <p className="wallet-muted">{description}</p>
              ) : (
                <p className="wallet-link break-all">{connection.uri}</p>
              )}
            </div>
          </div>
        </div>

        <div className="wallet-surface-strong border border-[var(--wallet-border)] rounded p-3 text-left space-y-2 mb-4">
          <div className="text-xs uppercase tracking-wide wallet-muted">
            Connected On
          </div>
          <div className="wallet-text-strong">{connectedAt}</div>
        </div>

        <div className="grid grid-cols-2 gap-3 pt-1">
          <button
            onClick={onClose}
            className="wallet-btn-secondary px-3 py-2 text-sm sm:text-base"
          >
            Close
          </button>
          <button
            onClick={() => onDisconnect(connectionId)}
            className="wallet-btn-danger px-3 py-2 text-sm sm:text-base whitespace-nowrap"
          >
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
};

export default WizardConnectionSettingsModal;
