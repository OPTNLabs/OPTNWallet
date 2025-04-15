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
    return <div className="text-center text-gray-600">No active sessions.</div>;
  }

  return (
    <div className="space-y-4">
      {Object.entries(activeSessions).map(([topic, session]) => {
        const dappMeta = session.peer.metadata;
        return (
          <div
            key={topic}
            className="p-4 border rounded-lg shadow-sm bg-white flex flex-col md:flex-row md:items-center justify-between"
          >
            <div className="flex items-center space-x-4">
              <img
                src={dappMeta.icons[0]}
                alt="DApp icon"
                className="w-16 h-16 rounded-full"
              />
              <div>
                <div className="font-bold text-xl">{dappMeta.name}</div>
                <a
                  href={dappMeta.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-blue-500 underline"
                >
                  {dappMeta.url}
                </a>
                <p className="text-gray-600 text-sm mt-1">{dappMeta.description}</p>
              </div>
            </div>
            <div className="flex space-x-4 mt-4 md:mt-0">
              <button
                onClick={() => onOpenSettings(topic)}
                className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded"
              >
                Settings
              </button>
              <button
                onClick={() => onDeleteSession(topic)}
                className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded"
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
