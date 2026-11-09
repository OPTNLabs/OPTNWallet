import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');

describe('shared wallet button targets', () => {
  it('keeps destructive actions touch-sized like primary and secondary actions', () => {
    const dangerRule = source.match(
      /\.wallet-btn-danger\s*\{([\s\S]*?)\n\s*\}/
    )?.[1];

    expect(dangerRule).toContain('min-h-[44px]');
  });
});
