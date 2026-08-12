// src/components/walletconnect/SessionList.tsx
import type { SessionTypes } from '@walletconnect/types';

interface Props {
  activeSessions: Record<string, SessionTypes.Struct> | null;
  onDeleteSession: (topic: string) => void;
  onOpenSettings: (topic: string) => void;
}

export function SessionList({
  activeSessions,
  onDeleteSession,
  onOpenSettings,
}: Props) {
  if (!activeSessions || Object.keys(activeSessions).length === 0) {
    return <div className="text-center wallet-muted">No active sessions.</div>;
  }

  return (
    <div className="space-y-4 max-h-96 overflow-y-auto">
      {Object.entries(activeSessions).map(([topic, session]) => {
        const dappMeta = session.peer.metadata;
        // console.log(dappMeta);
        return (
          <div
            key={topic}
            className="wallet-card p-4 flex flex-col md:flex-row md:items-center justify-between"
          >
            <div className="flex items-center space-x-4">
              <img
                src={dappMeta.icons[0]}
                alt="DApp icon"
                className="w-16 h-16 rounded-full"
              />
              <div className="text-center">
                <div className="font-bold text-xl">{dappMeta.name}</div>
                <a
                  href={dappMeta.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm wallet-link underline"
                >
                  {dappMeta.url}
                </a>
                <p className="wallet-muted text-sm mt-1">
                  {dappMeta.description}
                </p>
              </div>
            </div>
            <div className="flex justify-between mt-4 md:mt-0">
              <button
                onClick={() => onOpenSettings(topic)}
                className="wallet-btn-secondary"
              >
                Settings
              </button>
              <button
                onClick={() => onDeleteSession(topic)}
                className="wallet-btn-danger px-4 py-2"
              >
                Disconnect
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
