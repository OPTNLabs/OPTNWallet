// Extension popup wrapper around the real app. Referenced directly by
// src/platform/extension/main.tsx (its own dedicated entry point) — unlike
// the desktop build, no module-swap plugin is needed here, since this entry
// point isn't shared with any other build target.
import React from 'react';
import AppShell from '../../app/AppShell';
import ExtensionSecurityGate from './ExtensionSecurityGate';

const ExtensionAppShell: React.FC = () => (
  <ExtensionSecurityGate>
    <AppShell viewerOnly />
  </ExtensionSecurityGate>
);

export default ExtensionAppShell;
