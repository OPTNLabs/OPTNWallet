import { invoke } from '@tauri-apps/api/core';
import { isDesktopPlatform } from '../../utils/platform';
import {
  isThemeMode,
  isUiSkin,
  type ThemeMode,
  type UiSkin,
} from '../../app/theme/themeContextCore';

/**
 * Appearance lives in the shared Rust application state, not in this renderer.
 *
 * `optn_app_snapshot` / `optn_app_dispatch` are the same typed contract the
 * Leptos and Dioxus renderers use (`optn-transport`), so a mode chosen in one
 * is the mode the others paint, and the host is what writes it to disk.
 * Non-desktop surfaces have no such host and keep using local storage.
 */
const WIRE_PROTOCOL_VERSION = 1;

/** Wire names are snake_case and identical to `ThemeMode` / `UiSkin`. */
export type Appearance = { mode: ThemeMode; skin: UiSkin };

export async function readEngineAppearance(): Promise<Appearance | null> {
  if (!isDesktopPlatform()) return null;
  try {
    const snapshot = await invoke<{ theme?: unknown; skin?: unknown }>(
      'optn_app_snapshot'
    );
    const mode = snapshot?.theme;
    const skin = snapshot?.skin;
    // A snapshot that cannot be read is not an instruction to change the
    // user's appearance: keep whatever this renderer already had.
    if (!isThemeMode(mode)) return null;
    return { mode, skin: isUiSkin(skin) ? skin : 'default' };
  } catch {
    return null;
  }
}

async function dispatch(action: Record<string, unknown>): Promise<void> {
  await invoke('optn_app_dispatch', {
    action: { version: WIRE_PROTOCOL_VERSION, action },
  });
}

/**
 * Persist through the runtime. Failures are reported to the caller rather than
 * swallowed: the mode is already applied on screen, and saying nothing would
 * promise a durability the host did not provide.
 */
export async function persistEngineAppearance({
  mode,
  skin,
}: Appearance): Promise<void> {
  if (!isDesktopPlatform()) return;
  await dispatch({ type: 'set_theme', value: mode });
  await dispatch({ type: 'set_skin', value: skin });
}
