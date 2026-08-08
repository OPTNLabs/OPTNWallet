// Minimal runtime shim to satisfy libs touching `process`/`global`, matching
// index.html's inline shim — externalized because MV3's extension-page CSP
// forbids inline <script> blocks (no 'unsafe-inline' override is possible).
const compatibilityWindow = window as unknown as Record<string, unknown>;
compatibilityWindow.global ??= window;
compatibilityWindow.process ??= { env: {} };
