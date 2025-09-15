import processPolyfill from 'process';
import { Buffer as BufferPolyfill } from 'buffer';

declare global {
  interface Window {
    process?: any;
    Buffer?: any;
  }
  // If you use SES/lockdown, avoid polluting globalThis – but for Vite apps this is OK.
}

if (!window.process) window.process = processPolyfill;
if (!window.Buffer) window.Buffer = BufferPolyfill;
