import { useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '../../redux/store';
import { disconnectWizardConnection } from '../../redux/wizardconnectSlice';
import WizardConnectionManager from './WizardConnectionManager';

export default function WizardConnectPanel() {
  const dispatch = useDispatch<AppDispatch>();
  const connections = useSelector((state: RootState) => state.wizardconnect.activeConnections);
  const connectionEntries = Object.values(connections).sort(
    (left, right) => right.connectedAt - left.connectedAt
  );

  const handleDisconnect = useCallback(
    (connectionId: string) => {
      void dispatch(disconnectWizardConnection(connectionId));
    },
    [dispatch]
  );

  return (
    <div className="p-4 space-y-4">
      <WizardConnectionManager />

      <div className="wallet-card p-4 space-y-3">
        <h3 className="text-xl font-bold wallet-text-strong">Active WizardConnect Sessions</h3>

        {connectionEntries.length === 0 ? (
          <p className="wallet-muted text-sm">No active WizardConnect sessions yet.</p>
        ) : (
          <div className="space-y-3">
            {connectionEntries.map((connection) => (
              <div
                key={connection.id}
                className="wallet-surface-strong border border-[var(--wallet-border)] rounded-xl p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold wallet-text-strong">
                      {connection.dappName ?? connection.label}
                    </div>
                    <div className="wallet-muted text-sm">{connection.status.status}</div>
                  </div>
                  <button
                    className="wallet-btn-danger text-sm px-3 py-1.5 shrink-0"
                    onClick={() => handleDisconnect(connection.id)}
                  >
                    Disconnect
                  </button>
                </div>
                <div className="wallet-muted text-xs break-all">{connection.uri}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
