import { registerPlugin } from '@capacitor/core';

export type PlayUpdateStatus = {
  available: boolean;
  updateAvailability: number;
  updatePriority: number;
  status: number;
  stalenessDays: number | null;
  isImmediateAllowed: boolean;
  isFlexibleAllowed: boolean;
  availableVersionCode: number;
  isDownloaded: boolean;
};

export interface PlayUpdatePlugin {
  checkForUpdate(): Promise<PlayUpdateStatus>;
  startFlexibleUpdate(): Promise<{ started: boolean }>;
  completeUpdate(): Promise<void>;
}

const PlayUpdate = registerPlugin<PlayUpdatePlugin>('PlayUpdate');

export default PlayUpdate;
