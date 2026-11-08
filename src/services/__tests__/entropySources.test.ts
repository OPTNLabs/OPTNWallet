// Where the wallet's randomness comes from, enforced at the source.
//
// Wallets that lost funds to weak randomness lost them the same way: a
// predictable generator quietly stood in for the real one. Coldcard (2026)
// fell back to a generator seeded from the chip's ID and timers; Trust
// Wallet's WASM core used a Mersenne Twister with a 32-bit seed
// (CVE-2023-31290); the Randstorm browser wallets got Math.random where Web
// Crypto was missing. None of these failed a test, because the output still
// looked random. So these tests read the code, not the output.
//
// New recovery phrases come from crates/optn-core's hd::generate_mnemonic
// (the OS CSPRNG read directly, no fallback); its own tests cover the draw.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const SKIP_DIRS = new Set([
  'node_modules',
  'target',
  'generated',
  '__tests__',
  'dist',
]);

function sourceFiles(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        found.push(...sourceFiles(join(dir, entry.name), extensions));
      }
    } else if (
      extensions.some((extension) => entry.name.endsWith(extension)) &&
      !/\.(test|spec)\.[^.]+$/.test(entry.name)
    ) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function repoPath(file: string): string {
  return relative(ROOT, file).replaceAll('\\', '/');
}

/**
 * The code of a TS or Rust file with its comments blanked, so that a comment
 * explaining why Math.random or thread_rng is not used does not count as a
 * use. Line numbers are kept. A `//` inside a string ends that line early,
 * which can only hide code after a URL on the same line.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '');
}

/**
 * The only places Math.random may appear, each making something that is not
 * a secret. Anything else that needs randomness uses crypto.getRandomValues
 * and fails when it is missing.
 */
const MATH_RANDOM_ALLOWED: Record<string, string> = {
  'src/apis/ElectrumServer/ElectrumServer.ts': 'reconnect backoff jitter',
  'src/features/nostr/NostrChat.tsx': 'local id for an unsent message',
  'src/pages/apps/airdrops/screens/AirdropDistributionScreen.tsx':
    'record id where randomUUID is missing',
  'src/pages/apps/merchant-pay/merchantPayRequest.ts':
    'request id where randomUUID is missing',
  'src/platform/desktop/fusionAutoEngine.ts':
    'retry backoff jitter between rounds',
  'src/platform/desktop/onboarding/DesktopCreateWalletPage.tsx':
    'which shown words the user re-types; the words are on screen',
  'src/platform/desktop/walletFile.ts': 'file-name collision suffix',
  'src/services/WalletBackendSyncService.ts':
    'record id where randomUUID is missing',
};

describe('entropy sources', () => {
  const tsFiles = sourceFiles(join(ROOT, 'src'), ['.ts', '.tsx']);

  it('keeps Math.random out of everything that needs real randomness', () => {
    const offenders = tsFiles
      .filter((file) => /\bMath\.random\b/.test(code(file)))
      .map(repoPath)
      .filter((file) => !(file in MATH_RANDOM_ALLOWED));
    expect(offenders).toEqual([]);
  });

  it('leaves no JS phrase generator for a new wallet to reach', () => {
    // bip39.js can generate phrases (with whatever randomBytes it is given);
    // the core generator replaced it. Tests still use it as an oracle.
    const importers = tsFiles
      .filter((file) =>
        /from ['"]bip39['"]|require\(['"]bip39['"]\)/.test(code(file))
      )
      .map(repoPath);
    expect(importers).toEqual([]);
  });

  it('keeps userspace and seeded PRNGs out of the Rust sources', () => {
    // thread_rng is a ChaCha PRNG seeded from the OS, and bip39's
    // Mnemonic::generate draws from it. OsRng and getrandom read the OS
    // directly, which is what every key, nonce and phrase here uses; bip39's
    // generate_in_with is allowed only when OsRng is what it is handed.
    const forbidden =
      /\b(?:thread_rng|SmallRng|StdRng|ChaCha\d+Rng|seed_from_u64|rand::random|fastrand::|Mnemonic::generate(_in)?\(|Mnemonic::generate_in_with\((?!&mut OsRng\b))/;
    const crateSources = readdirSync(join(ROOT, 'crates'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(ROOT, 'crates', entry.name, 'src'));
    const offenders = [...crateSources, join(ROOT, 'src-tauri', 'src')]
      .flatMap((dir) => {
        try {
          return sourceFiles(dir, ['.rs']);
        } catch {
          return [];
        }
      })
      .flatMap((file) =>
        code(file)
          .split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => forbidden.test(line))
          .map(
            ({ line, index }) =>
              `${repoPath(file)}:${index + 1}: ${line.trim()}`
          )
      );
    expect(offenders).toEqual([]);
  });

  it('draws new phrases in the core, not from caller-supplied bytes', () => {
    const bip39Service = code(join(ROOT, 'src/services/Bip39Service.ts'));
    expect(bip39Service).toContain('bip39GenerateMnemonic(');
    expect(bip39Service).not.toMatch(/getRandomValues|Math\.random/);
    const hd = code(join(ROOT, 'crates/optn-core/src/hd.rs'));
    expect(hd).toContain(
      'Mnemonic::generate_in_with(&mut OsRng, Language::English, word_count)'
    );
  });
});
