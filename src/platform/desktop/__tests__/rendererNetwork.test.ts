import { describe, expect, it } from 'vitest';
import { bridgedToRust, isAppHost, isLoopbackHost } from '../rendererNetwork';

const page = 'http://tauri.localhost/#/landing';

describe('the fetch bridge routes only remote http(s) through Rust', () => {
  it('never bridges Tauri IPC, so a command cannot loop back into IPC', () => {
    // WebView2 carries every invoke as a fetch to ipc.localhost; the bridge is
    // itself an invoke. Bridging these grew the renderer past 7 GB.
    for (const url of [
      'http://ipc.localhost/optn_http_fetch',
      'https://ipc.localhost/plugin%3Awebview%7Ccreate_webview_window',
      'http://IPC.LOCALHOST./x',
      'http://asset.localhost/C%3A/icons/token.png',
      'ipc://localhost/optn_http_fetch',
    ]) {
      expect(bridgedToRust(url, page), url).toBe(false);
    }
  });

  it('keeps the page, loopback and non-http schemes on the webview', () => {
    for (const url of [
      '/assets/logo.png',
      'http://tauri.localhost/assets/x.js',
      'http://127.0.0.1:21325/', // Trezor Bridge
      'http://localhost:5174/src/main.tsx',
      'http://[::1]:8080/',
      'data:text/plain,hi',
      'blob:http://tauri.localhost/1',
      'not a url at all \u0000',
    ]) {
      expect(bridgedToRust(url, page), url).toBe(false);
    }
  });

  it('bridges remote hosts, including ones that only look local', () => {
    for (const url of [
      'https://indexer.riften.net/v1/x',
      'http://bcmr.example/registry.json',
      'https://localhost.example.com/',
      'https://ipc.localhost.example.com/',
      'http://192.168.0.10/',
    ]) {
      expect(bridgedToRust(url, page), url).toBe(true);
    }
  });

  it('keeps the loopback rule identical to Rust and separate from app hosts', () => {
    expect(isAppHost('ipc.localhost')).toBe(true);
    expect(isAppHost('asset.localhost.')).toBe(true);
    expect(isAppHost('localhost')).toBe(false);
    expect(isAppHost('localhost.example.com')).toBe(false);
    // Rust's is_loopback_host accepts exactly these; *.localhost is not one.
    expect(isLoopbackHost('ipc.localhost')).toBe(false);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
  });
});
