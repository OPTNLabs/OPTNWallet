import { useCallback, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RelayConnectionState } from '@wizardconnect/wallet';
import type { AppDispatch, RootState } from '../../state/store';
import { disconnectWizardConnection } from '../../state/slices/wizardconnectSlice';
import WizardConnectionManager from './WizardConnectionManager';
import WizardConnectionSettingsModal from './WizardConnectionSettingsModal';
import WizardDappAvatar from './WizardDappAvatar';
import { useI18n } from '../../i18n/useI18n';
import { wizardConnectionStatus } from '../../utils/connectionStatus';
import InfoButton from '../ui/InfoButton';
import MaskedValue from '../ui/MaskedValue';

type WizardConnectView = RelayConnectionState & {
  dappDescription?: string | null;
};

export default function WizardConnectPanel() {
  const dispatch = useDispatch<AppDispatch>();
  const { t } = useI18n();
  const connections = useSelector(
    (state: RootState) => state.wizardconnect.activeConnections
  );
  const connectionEntries = Object.values(connections).sort(
    (left, right) => right.connectedAt - left.connectedAt
  );
  const [settingsConnectionId, setSettingsConnectionId] = useState<
    string | null
  >(null);

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
    <div className="min-w-0 space-y-4 p-4">
      <WizardConnectionManager />

      <div className="wallet-card min-w-0 space-y-3 p-4">
        {connectionEntries.length === 0 ? (
          <p className="wallet-muted text-sm">{t('wizard.noActiveSessions')}</p>
        ) : (
          <>
            <h3 className="text-lg sm:text-xl font-bold wallet-text-strong">
              {t('connection.attempts')}
            </h3>
            <div className="max-h-96 min-w-0 space-y-4 overflow-y-auto pb-4">
              {connectionEntries.map((connection) => {
                const view = connection as WizardConnectView;
                const description = view.dappDescription?.trim();
                const fallbackDetail = description || view.uri;

                return (
                  <div
                    key={connection.id}
                    className="wallet-card flex w-full min-w-0 flex-col gap-4 p-4"
                    data-testid="wizard-connection-attempt"
                  >
                    <div className="flex min-w-0 w-full items-start gap-3">
                      <WizardDappAvatar
                        name={connection.dappName ?? connection.label}
                        iconUrl={connection.dappIcon}
                        className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full wallet-surface-strong border border-[var(--wallet-border)] bg-[var(--wallet-surface)]"
                      />
                      <div className="min-w-0 flex-1 text-left">
                        <div className="break-words font-bold text-base sm:text-lg lg:text-xl wallet-text-strong [overflow-wrap:anywhere]">
                          {connection.dappName ??
                            connection.label ??
                            'WizardConnect'}
                        </div>
                        <div className="flex items-center gap-1">
                          <div className="wallet-muted text-xs sm:text-sm">
                            {t(
                              wizardConnectionStatus(connection.status.status)
                            )}
                          </div>
                          <InfoButton
                            id={`wizard-connection-status-${connection.id}`}
                            ariaLabel={t('connection.statusHelpLabel')}
                            content={t('connection.statusHelp')}
                          />
                        </div>
                        <div className="mt-1 min-w-0 text-xs sm:text-sm leading-relaxed">
                          {description ? (
                            <p className="wallet-muted [overflow-wrap:anywhere]">
                              {description}
                            </p>
                          ) : fallbackDetail ? (
                            <MaskedValue
                              value={fallbackDetail}
                              label={t('wizard.connectionUri')}
                              ariaLabel={t('wizard.connectionUri')}
                              className="w-full max-w-full text-xs sm:text-sm"
                              prefixLength={8}
                              suffixLength={10}
                              revealOnClick
                              testId="wizard-connection-uri"
                            />
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="grid w-full min-w-0 grid-cols-2 gap-2">
                      <button
                        onClick={() => handleOpenSettings(connection.id)}
                        className="wallet-btn-secondary px-3 py-2 text-sm md:text-base"
                      >
                        {t('wizard.settings')}
                      </button>
                      <button
                        onClick={() => handleDisconnect(connection.id)}
                        className="wallet-btn-danger px-3 py-2 text-sm md:text-base whitespace-nowrap"
                      >
                        {t('wizard.disconnect')}
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
