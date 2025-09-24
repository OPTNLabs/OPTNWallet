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

const g: any = globalThis as any;

if (!g.global) g.global = g; // some libs expect `global`
if (!g.process) g.process = { env: {} }; // avoid ReferenceError for `process`
if (!g.Buffer) g.Buffer = Buffer; // for libs that expect Buffer
