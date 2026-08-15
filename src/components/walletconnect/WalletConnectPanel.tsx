// src/components/walletconnect/WalletConnectPanel.tsx
import { useState, useCallback, useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../state/store';

import WcConnectionManager from '../WcConnectionManager';
import { SessionList } from './SessionList';
import SessionSettingsModal from './SessionSettingsModal';
import { disconnectSession } from '../../state/slices/walletconnectSlice';
import { SignMessageModal } from './SignMessageModal';
import { useI18n } from '../../i18n/useI18n';

export default function WalletConnectPanel() {
  const { t } = useI18n();
  const dispatch = useDispatch<AppDispatch>();
  const sessions = useSelector(
    (s: RootState) => s.walletconnect.activeSessions
  );
  const [settingsTopic, setSettingsTopic] = useState<string | null>(null);

  // Check for expired sessions when the component mounts or sessions change
  useEffect(() => {
    if (!sessions) return;

    const now = Math.floor(Date.now() / 1000); // Current time in seconds
    const expiredTopics = Object.entries(sessions)
      .filter(([, session]) => session.expiry && now > session.expiry)
      .map(([topic]) => topic);

    // Disconnect all expired sessions
    expiredTopics.forEach((topic) => {
      dispatch(disconnectSession(topic));
    });
  }, [sessions, dispatch]);

  /* -------- actions ---------- */
  const handleDelete = useCallback(
    (topic: string) => {
      dispatch(disconnectSession(topic));
    },
    [dispatch]
  );

  const handleOpen = useCallback((topic: string) => {
    setSettingsTopic(topic);
  }, []);

  return (
    <div className="p-4">
      {/* <h2 className="text-3xl text-center font-bold mb-4">WalletConnect</h2> */}
      <WcConnectionManager />

      <div className="wallet-card p-4 space-y-3">
        {!sessions || Object.keys(sessions).length === 0 ? (
          <p className="wallet-muted text-sm">{t('wc.noActiveSessions')}</p>
        ) : (
          <>
            <h3 className="text-xl font-bold wallet-text-strong">
              {t('wc.activeSessions')}
            </h3>
            <SessionList
              activeSessions={sessions}
              onDeleteSession={handleDelete}
              onOpenSettings={handleOpen}
            />
          </>
        )}
      </div>

      {/* Per-session settings */}
      {settingsTopic && (
        <SessionSettingsModal
          sessionTopic={settingsTopic}
          onClose={() => setSettingsTopic(null)}
        />
      )}

      {/* Signing request modals */}
      <SignMessageModal />
      {/* <SignTransactionModal /> */}
    </div>
  );
}
