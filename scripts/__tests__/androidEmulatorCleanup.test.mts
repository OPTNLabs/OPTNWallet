import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bashExecutable =
  process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\bin\\bash.exe'
    : 'bash';
const androidPreviewWorkflow = readFileSync(
  resolve(repoRoot, '.github', 'workflows', 'android-preview.yml'),
  'utf8'
);

describe('Android emulator cleanup', () => {
  it('forcibly reaps a child that ignores graceful shutdown', () => {
    expect(() =>
      execFileSync(
        bashExecutable,
        [
          '-c',
          `source scripts/stop-child-process.sh
bash -c 'trap "" TERM; while :; do :; done' &
child_pid=$!
stop_child_process "$child_pid" 0.1 0.1
! kill -0 "$child_pid" 2>/dev/null`,
          'android-emulator-cleanup-test',
        ],
        { cwd: repoRoot, stdio: 'pipe', timeout: 5_000 }
      )
    ).not.toThrow();
  });

  it('uses bounded child cleanup after asking the emulator to stop', () => {
    expect(androidPreviewWorkflow).toContain(
      'source scripts/stop-child-process.sh'
    );
    expect(androidPreviewWorkflow).toMatch(
      /adb_with_timeout[\s\S]*emu kill[\s\S]*stop_child_process "\$emulator_pid"/
    );
    expect(androidPreviewWorkflow).not.toContain(
      'wait "$emulator_pid" 2>/dev/null || true'
    );
  });
});
