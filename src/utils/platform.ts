import { Capacitor } from '@capacitor/core';

function userAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function looksLikeAndroid(): boolean {
  return /android/i.test(userAgent());
}

function looksLikeIos(): boolean {
  return /iPhone|iPad|iPod/i.test(userAgent());
}

// Tauri injects this global into every Tauri WebView, including Android/iOS.
// Those hosts are not desktop: USB hardware and desktop-only aliases must stay off.
export function isDesktopPlatform(): boolean {
  if (!isTauriRuntime()) return false;
  if (Capacitor.isNativePlatform()) return false;
  const platform = Capacitor.getPlatform();
  if (platform === 'android' || platform === 'ios') return false;
  if (looksLikeAndroid() || looksLikeIos()) return false;
  return true;
}

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export function isWebPlatform(): boolean {
  return Capacitor.getPlatform() === 'web';
}

export function isAndroidNativePlatform(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}
