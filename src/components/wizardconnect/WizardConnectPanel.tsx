import { useCallback, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RelayConnectionState } from '@wizardconnect/wallet';
import type { AppDispatch, RootState } from '../../state/store';
import { disconnectWizardConnection } from '../../state/slices/wizardconnectSlice';
import WizardConnectionManager from './WizardConnectionManager';
import WizardConnectionSettingsModal from './WizardConnectionSettingsModal';
import WizardDappAvatar from './WizardDappAvatar';

type WizardConnectView = RelayConnectionState & {
  dappDescription?: string | null;
};

export default function WizardConnectPanel() {
  const dispatch = useDispatch<AppDispatch>();
  const connections = useSelector((state: RootState) => state.wizardconnect.activeConnections);
  const connectionEntries = Object.values(connections).sort(
    (left, right) => right.connectedAt - left.connectedAt
  );
  const [settingsConnectionId, setSettingsConnectionId] = useState<string | null>(null);

  const handleDisconnect = useCallback(
    (connectionId: string) => {
      void dispatch(disconnectWizardConnection(connectionId));
    },
    [dispatch]
  );

  const handleOpenSettings = useCallback((connectionId: string) => {
    setSettingsConnectionId(connectionId);
  }, []);

  return (
    <div className="p-4 space-y-4">
      <WizardConnectionManager />

      <div className="wallet-card p-4 space-y-3">
        {connectionEntries.length === 0 ? (
          <p className="wallet-muted text-sm">
            No active WizardConnect sessions yet.
          </p>
        ) : (
          <>
            <h3 className="text-lg sm:text-xl font-bold wallet-text-strong">
              Active WizardConnect Sessions
            </h3>
          <div className="space-y-4 max-h-96 overflow-y-auto">
            {connectionEntries.map((connection) => {
              const view = connection as WizardConnectView;
              const description = view.dappDescription?.trim();
              const fallbackDetail = description || view.uri;

              return (
              <div
                key={connection.id}
                className="wallet-card p-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <WizardDappAvatar
                    name={connection.dappName ?? connection.label}
                    iconUrl={connection.dappIcon}
                    className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full wallet-surface-strong border border-[var(--wallet-border)] bg-[var(--wallet-surface)]"
                  />
                  <div className="text-center md:text-left min-w-0 flex-1">
                    <div className="font-bold text-base sm:text-lg lg:text-xl wallet-text-strong break-words">
                      {connection.dappName ?? connection.label ?? 'WizardConnect'}
                    </div>
                    <div className="wallet-muted text-xs sm:text-sm">
                      {connection.status.status}
                    </div>
                    <div className="mt-1 text-xs sm:text-sm leading-relaxed break-words">
                      {description ? (
                        <p className="wallet-muted">{description}</p>
                      ) : (
                        <p className="wallet-link break-all">{fallbackDetail}</p>
                      )}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 md:flex md:justify-end md:gap-3 md:mt-0">
                  <button
                    onClick={() => handleOpenSettings(connection.id)}
                    className="wallet-btn-secondary px-3 py-2 text-sm md:text-base"
                  >
                    Settings
                  </button>
                  <button
                    onClick={() => handleDisconnect(connection.id)}
                    className="wallet-btn-danger px-3 py-2 text-sm md:text-base whitespace-nowrap"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
              );
            })}
          </div>
          </>
        )}
      </div>

      {settingsConnectionId && (
        <WizardConnectionSettingsModal
          connectionId={settingsConnectionId}
          onDisconnect={(connectionId) => {
            handleDisconnect(connectionId);
            setSettingsConnectionId(null);
          }}
          onClose={() => setSettingsConnectionId(null)}
        />
      )}
    </div>
  );
}
