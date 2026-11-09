import { invoke } from '@tauri-apps/api/core';
import { showWalletStatus } from '../../utils/copyWithFeedback';

/** Open a web URL in the system browser and report shell failures visibly. */
export async function openExternal(url: string): Promise<boolean> {
  try {
    await invoke('open_external', { url });
    return true;
  } catch {
    showWalletStatus('Could not open the browser. Please try again.');
    return false;
  }
}
