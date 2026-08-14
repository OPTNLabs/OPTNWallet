/**
 * Privacy boundary: P2P / desktop CashFusion must never import the wallet's
 * long-lived Nostr identity (seed-derived npub) or the chat layer that loads it.
 *
 * Pool announce, gift-wrap, and component traffic must use only:
 *   - generateRoundIdentity() throwaways (control plane), and
 *   - per-message generateSecretKey() throwaways (anonymous components).
 *
 * A static import of `identity` / `chat` would re-link fusion rounds to the
 * permanent social key. This test fails CI if that regression lands.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** File basenames that load the permanent Nostr wallet identity. */
const FORBIDDEN_MODULE_BASENAMES = new Set(['identity', 'chat']);

/**
 * Import paths that resolve to those modules (relative or package-style).
 * Matches e.g. `./identity`, `../nostr/identity`, `.../chat`, `.../chat.ts`.
 */
const FORBIDDEN_IMPORT_RE =
  /from\s+['"](?:[^'"]*[/\\])?(identity|chat)(?:\.(?:ts|js|tsx|jsx))?['"]/;

/** Named imports that only exist on the social/chat path. */
const FORBIDDEN_SYMBOL_RE =
  /\b(myIdentity|deriveNostrIdentity|NOSTR_DERIVATION_PATH)\b/;

function isFusionSourceFile(name: string): boolean {
  if (!name.endsWith('.ts') && !name.endsWith('.tsx')) return false;
  if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) return false;
  const base = name.replace(/\.(tsx?)$/, '');
  return /^[Ff]usion/.test(base);
}

function walkFusionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') {
      continue;
    }
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFusionSources(full, out);
      continue;
    }
    if (isFusionSourceFile(entry)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  // Enough for import-line scanning; not a full TS parser.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function findForbiddenHits(source: string): string[] {
  const body = stripComments(source);
  const hits: string[] = [];

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const importMatch = trimmed.match(FORBIDDEN_IMPORT_RE);
    if (importMatch) {
      const mod = importMatch[1];
      if (FORBIDDEN_MODULE_BASENAMES.has(mod)) {
        hits.push(`import of ${mod}: ${trimmed}`);
      }
    }

    // require() / dynamic import() paths
    const dyn = trimmed.match(
      /(?:require|import)\s*\(\s*['"](?:[^'"]*[/\\])?(identity|chat)(?:\.(?:ts|js))?['"]\s*\)/
    );
    if (dyn && FORBIDDEN_MODULE_BASENAMES.has(dyn[1])) {
      hits.push(`dynamic load of ${dyn[1]}: ${trimmed}`);
    }

    if (FORBIDDEN_SYMBOL_RE.test(trimmed) && /^\s*import\b/.test(trimmed)) {
      hits.push(`forbidden identity/chat symbol: ${trimmed}`);
    }
  }

  return hits;
}

describe('CashFusion identity isolation', () => {
  const files = walkFusionSources(DESKTOP_ROOT).sort();

  it('finds fusion source files to audit', () => {
    // Guard against an empty walk (wrong root) silently passing the suite.
    expect(files.length).toBeGreaterThanOrEqual(15);
    const rel = files.map((f) => relative(DESKTOP_ROOT, f).split(sep).join('/'));
    expect(rel.some((p) => p.endsWith('FusionP2pService.ts'))).toBe(true);
    expect(rel.some((p) => p.includes('nostr/fusionTransport.ts'))).toBe(true);
    expect(rel.some((p) => p.includes('nostr/fusion.ts'))).toBe(true);
  });

  it('does not import wallet Nostr identity or chat from any Fusion*/fusion* module', () => {
    const violations: string[] = [];

    for (const file of files) {
      const rel = relative(DESKTOP_ROOT, file).split(sep).join('/');
      const source = readFileSync(file, 'utf8');
      for (const hit of findForbiddenHits(source)) {
        violations.push(`${rel}: ${hit}`);
      }
    }

    expect(
      violations,
      violations.length
        ? `Fusion modules must not touch permanent Nostr identity/chat:\n${violations.join('\n')}`
        : undefined
    ).toEqual([]);
  });
});
