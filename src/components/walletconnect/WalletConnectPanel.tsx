// src/components/walletconnect/WalletConnectPanel.tsx
import { useState, useCallback, useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../redux/store';

import WcConnectionManager from '../WcConnectionManager';
import SessionProposalModal from './SessionProposalModal';
import { SessionList } from './SessionList';
import SessionSettingsModal from './SessionSettingsModal';
import { disconnectSession } from '../../redux/walletconnectSlice';

export default function WalletConnectPanel() {
  const dispatch = useDispatch<AppDispatch>();
  const sessions = useSelector(
    (s: RootState) => s.walletconnect.activeSessions
  );
  const [settingsTopic, setSettingsTopic] = useState<string | null>(null);

  // Check for expired sessions when the component mounts or sessions change
  useEffect(() => {
    const now = Math.floor(Date.now() / 1000); // Current time in seconds
    const expiredTopics = Object.entries(sessions)
      .filter(([topic, session]) => session.expiry && now > session.expiry)
      .map(([topic]) => topic);

    // Disconnect all expired sessions
    expiredTopics.forEach((topic) => {
      console.log(`Disconnecting expired session: ${topic}`);
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

      {/* Incoming proposal */}
      <SessionProposalModal />

      {/* Active sessions list */}
      <SessionList
        activeSessions={sessions}
        onDeleteSession={handleDelete}
        onOpenSettings={handleOpen}
      />

      {/* Per-session settings */}
      {settingsTopic && (
        <SessionSettingsModal
          sessionTopic={settingsTopic}
          onClose={() => setSettingsTopic(null)}
        />
      )}

      {/* Signing request modals */}
      {/* <SignMessageModal /> */}
      {/* <SignTransactionModal /> */}
    </div>
  );
}