// src/components/walletconnect/SessionSettingsModal.tsx
import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState, AppDispatch } from '../../redux/store';
import { disconnectSession } from '../../redux/walletconnectSlice';

interface Props {
  sessionTopic: string;
  onClose: () => void;
}

const SessionSettingsModal: React.FC<Props> = ({ sessionTopic, onClose }) => {
  const dispatch = useDispatch<AppDispatch>();
  const session = useSelector((state: RootState) => state.walletconnect.activeSessions?.[sessionTopic]);
  if (!session) return null;
  const dappMeta = session.peer.metadata;

  const handleDisconnect = async () => {
    try {
      await dispatch(disconnectSession(sessionTopic)).unwrap();
    } catch (error) {
      console.error('Error disconnecting session:', error);
    } finally {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-70 z-50">
      <div className="bg-white rounded-lg shadow-lg max-w-md w-full p-6">
        <h2 className="text-2xl font-bold mb-4 text-center">Session Settings</h2>
        <div className="flex items-center space-x-4 mb-4">
          <img
            src={dappMeta.icons[0]}
            alt="DApp Icon"
            className="w-16 h-16 rounded-full"
          />
          <div>
            <p className="font-bold text-xl">{dappMeta.name}</p>
            <a href={dappMeta.url} target="_blank" rel="noreferrer" className="text-blue-500 underline text-sm">
              {dappMeta.url}
            </a>
          </div>
        </div>
        <p className="text-gray-600 mb-4">{dappMeta.description}</p>
        <div className="flex justify-end">
          <button
            onClick={handleDisconnect}
            className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded"
          >
            Disconnect
          </button>
          <button
            onClick={onClose}
            className="ml-4 px-4 py-2 bg-gray-300 hover:bg-gray-400 text-gray-800 rounded"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default SessionSettingsModal;
