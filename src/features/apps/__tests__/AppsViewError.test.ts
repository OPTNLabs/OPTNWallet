import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../AppsView.tsx', import.meta.url)),
  'utf8'
);

describe('Apps error disclosure', () => {
  it('keeps addon diagnostics behind technical details', () => {
    expect(source).toContain('<FriendlyErrorPanel');
    expect(source).toContain("t('send.technicalDetails')");
    expect(source).toContain('{error}');
  });
});
