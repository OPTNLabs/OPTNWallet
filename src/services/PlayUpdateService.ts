import { Capacitor } from '@capacitor/core';
import PlayUpdate, { type PlayUpdateStatus } from '../plugins/PlayUpdate';

const LAST_CHECK_KEY = 'optn_play_update_last_check_v1';
const LAST_VERSION_KEY = 'optn_play_update_last_version_v1';
const CHECK_INTERVAL_MS = 12 * 60 * 60_000;

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // best effort
  }
}

function shouldCheckNow(): boolean {
  const lastCheck = Number(readStorage(LAST_CHECK_KEY) ?? 0);
  return !Number.isFinite(lastCheck) || Date.now() - lastCheck >= CHECK_INTERVAL_MS;
}

function markChecked(versionCode: number): void {
  writeStorage(LAST_CHECK_KEY, String(Date.now()));
  writeStorage(LAST_VERSION_KEY, String(versionCode));
}

function readLastVersion(): number {
  const raw = Number(readStorage(LAST_VERSION_KEY) ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

async function checkForOptionalUpdate(): Promise<PlayUpdateStatus | null> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return null;
  if (!shouldCheckNow()) return null;

  const result = await PlayUpdate.checkForUpdate();
  markChecked(result.availableVersionCode);
  return result;
}

async function startOptionalUpdate(): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return false;
  const result = await PlayUpdate.startFlexibleUpdate();
  return !!result.started;
}

async function completeOptionalUpdate(): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;
  await PlayUpdate.completeUpdate();
}

const PlayUpdateService = {
  checkForOptionalUpdate,
  startOptionalUpdate,
  completeOptionalUpdate,
  readLastVersion,
};

export default PlayUpdateService;
