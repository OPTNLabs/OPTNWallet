// The desktop network bridges, loaded as their own module script before the
// app's (see vite.desktop.config.ts).
//
// Libraries capture `WebSocket` when their module loads (nostr-tools does), so
// the bridges must replace it before any app module runs. Imported from
// main.tsx they did not: the bundler hoists the entry's chunk imports above the
// entry's own code, and a library in one of those chunks loaded first, with
// the webview's socket. A separate module script is finished before the next
// one starts, whatever the chunking.

import './http-bridge';
import './socket-bridge';
