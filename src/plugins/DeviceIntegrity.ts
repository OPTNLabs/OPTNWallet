import { registerPlugin } from '@capacitor/core';

export interface DeviceIntegrityResult {
  compromised: boolean;
  reasons: string[];
}

export interface DeviceIntegrityPlugin {
  assess(): Promise<DeviceIntegrityResult>;
}

const DeviceIntegrity = registerPlugin<DeviceIntegrityPlugin>('DeviceIntegrity');

export default DeviceIntegrity;
