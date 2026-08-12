import processPolyfill from 'process';
import { Buffer as BufferPolyfill } from 'buffer';

declare global {
  interface Window {
    process?: { env?: Record<string, string | undefined> };
    Buffer?: typeof Buffer;
  }
  // If you use SES/lockdown, avoid polluting globalThis – but for Vite apps this is OK.
}

if (!window.process) window.process = processPolyfill;
if (!window.Buffer) window.Buffer = BufferPolyfill;

const g = globalThis as typeof globalThis & {
  global?: unknown;
  process?: unknown;
  Buffer?: typeof Buffer;
};

if (!g.global) g.global = g; // some libs expect `global`
if (!g.process) g.process = processPolyfill; // avoid ReferenceError for `process`
if (!g.Buffer) g.Buffer = Buffer; // for libs that expect Buffer
