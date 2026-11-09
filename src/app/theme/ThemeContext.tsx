import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getInitialSkin,
  getInitialTheme,
  persistTheme,
  ThemeContext,
  ThemeMode,
  UiSkin,
} from './themeContextCore';
import {
  persistEngineAppearance,
  readEngineAppearance,
} from '../../platform/desktop/appearanceBridge';

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [mode, setMode] = useState<ThemeMode>(getInitialTheme);
  const [skin, setSkin] = useState<UiSkin>(getInitialSkin);
  // Hydration must not be echoed back as a fresh choice: dispatching what the
  // runtime just told us would write on every launch and could overwrite a
  // newer selection made in another renderer.
  const hydrating = useRef(true);

  useEffect(() => {
    let cancelled = false;
    void readEngineAppearance().then((appearance) => {
      if (!cancelled && appearance) {
        setMode(appearance.mode);
        setSkin(appearance.skin);
      }
      if (!cancelled) hydrating.current = false;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    persistTheme(mode, skin);
    if (hydrating.current) return;
    void persistEngineAppearance({ mode, skin }).catch((error) => {
      // Applied for this session; the host could not store it. Surfacing the
      // reason beats a silent revert on next launch.
      console.error('[theme] appearance was not saved by the runtime:', error);
    });
  }, [mode, skin]);

  const value = useMemo(
    () => ({
      mode,
      skin,
      setMode,
      setSkin,
      // The quick control stays two-state: neutral Light surfaces or the
      // wallet's green Dark surfaces. Gray and Green remain available from
      // Settings -> Appearance.
      toggleMode: () =>
        setMode((previous) => (previous === 'light' ? 'dark' : 'light')),
    }),
    [mode, skin]
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
};
