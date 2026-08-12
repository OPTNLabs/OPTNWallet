import { Capacitor } from '@capacitor/core';

// Tauri injects this global into its desktop WebView before the app mounts.
// Browser and Capacitor mobile runtimes do not expose it.
export function isDesktopPlatform(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
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
