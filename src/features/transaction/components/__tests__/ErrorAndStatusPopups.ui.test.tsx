import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(
    process.cwd(),
    'src/features/transaction/components/ErrorAndStatusPopups.tsx'
  ),
  'utf8'
);

describe('custom transaction builder error disclosure', () => {
  it('keeps the default error actionable and the raw diagnostic behind disclosure', () => {
    expect(source).toContain('friendlyBuilderError(errorMessage, t)');
    expect(source).toContain("t('send.technicalDetails')");
    expect(source).toContain('flex min-h-[44px] cursor-pointer');
    expect(source).toContain('whitespace-pre-wrap break-words');
    expect(source).not.toContain('{errorMessage}</p>');
  });
});
