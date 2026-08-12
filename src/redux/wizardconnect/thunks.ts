import { createAsyncThunk } from '@reduxjs/toolkit';
import { Toast } from '@capacitor/toast';
import type { RootState } from '../store';

export const wizardConnectPair = createAsyncThunk(
  'wizardconnect/pair',
  async (uri: string, { getState }) => {
    const state = getState() as RootState;
    const manager = state.wizardconnect.manager;
    if (!manager) throw new Error('WizardConnect not initialized');
    const connectionId = manager.connect(uri);
    await Toast.show({ text: 'WizardConnect pairing started.' });
    return {
      connectionId,
      connections: manager.getConnections(),
    };
  }
);

export const disconnectWizardConnection = createAsyncThunk(
  'wizardconnect/disconnect',
  async (connectionId: string, { getState }) => {
    const state = getState() as RootState;
    const manager = state.wizardconnect.manager;
    if (!manager) throw new Error('WizardConnect not initialized');
    manager.disconnect(connectionId);
    return manager.getConnections();
  }
);

export const disconnectAllWizardConnections = createAsyncThunk(
  'wizardconnect/disconnectAll',
  async (_, { getState }) => {
    const state = getState() as RootState;
    const manager = state.wizardconnect.manager;
    if (!manager) return {};
    manager.disconnectAll();
    return manager.getConnections();
  }
);
