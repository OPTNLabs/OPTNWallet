import { registerPlugin } from '@capacitor/core';

export interface ScreenSecurityPlugin {
  setSecure(options: { enabled: boolean }): Promise<void>;
}

const ScreenSecurity = registerPlugin<ScreenSecurityPlugin>('ScreenSecurity');

export default ScreenSecurity;
